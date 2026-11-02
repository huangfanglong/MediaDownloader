import { afterEach, describe, expect, it } from "vitest";
import { bootContentScript } from "../src/extension/content-script.js";
import type { BrowserGateway } from "../src/extension/gateways.js";
import { PAGE_ON_MEDIA_HINTS } from "../src/extension/media-hint.js";
import { TabHealing } from "../src/extension/tab-healing.js";
import { Channel, cyrb53 } from "../src/protocol/channels.js";

const PAGE_URL = "https://page.test/watch";
const CHANNEL_NAME = `injected-${cyrb53(PAGE_URL)}`;
const MARKER_KEY = "content_scripts_healed";

interface Listener {
  (message: unknown): void;
}

/** A fake `chrome.runtime` for one extension context. */
class SimulatedRuntime {
  behavior: "ok" | "invalidated" = "ok";
  readonly messages: unknown[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(public id: string | undefined) {}

  async sendMessage(message: unknown): Promise<unknown> {
    if (this.behavior === "invalidated") throw new Error("Extension context invalidated");
    this.messages.push(message);
    return undefined;
  }

  readonly onMessage = {
    addListener: (listener: Listener): void => {
      this.listeners.add(listener);
    },
    removeListener: (listener: Listener): void => {
      this.listeners.delete(listener);
    },
  };
}

interface Simulation {
  gateway: BrowserGateway;
  injectedFiles: string[][];
  session: Map<string, unknown>;
  setPageHookInstalled(installed: boolean): void;
  isPageHookInstalled(): boolean;
}

function createSimulation(): Simulation {
  const session = new Map<string, unknown>();
  const injectedFiles: string[][] = [];
  let pageHookInstalled = false;
  const gateway = {
    storage: {
      session: {
        get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) session.set(key, value);
        },
      },
    },
    tabs: { query: async () => [{ id: 7, url: PAGE_URL }] },
    scripting: {
      executeInTab: async (_tabId: number, func: (...args: never[]) => unknown, args: unknown[]) =>
        func(...(args as never[])),
      executeFilesInTab: async (_tabId: number, files: string[]) => {
        injectedFiles.push([...files]);
        if (files.includes("page-hook.js")) pageHookInstalled = true;
        if (files.includes("content-script.js")) bootContentScript();
      },
    },
  } as unknown as BrowserGateway;
  return {
    gateway,
    injectedFiles,
    session,
    setPageHookInstalled: (installed) => {
      pageHookInstalled = installed;
      (globalThis as Record<string, unknown>).__mediaDownloaderHookInstalled = installed || undefined;
    },
    isPageHookInstalled: () => pageHookInstalled,
  };
}

const disposers: Array<() => void> = [];
const posters: BroadcastChannel[] = [];

function activateRuntime(runtime: SimulatedRuntime): void {
  Object.defineProperty(globalThis, "location", {
    value: { href: PAGE_URL },
    configurable: true,
    writable: true,
  });
  (globalThis as unknown as { chrome?: { runtime: SimulatedRuntime } }).chrome = { runtime };
}

function installBridge(runtime: SimulatedRuntime): void {
  activateRuntime(runtime);
  disposers.push(bootContentScript());
}

function bridgePing(): boolean | undefined {
  const ping = (globalThis as { __mediaDownloaderBridgePing?: () => boolean }).__mediaDownloaderBridgePing;
  return ping?.();
}

/** Assert the current isolated-world bridge reports a live extension context. */
function expectBridgeAlive(): void {
  expect(bridgePing()).toBe(true);
  expect(globalThis).toHaveProperty("__mediaDownloaderContentBridgeInstalled", true);
  const runtime = (globalThis as unknown as { chrome?: { runtime: SimulatedRuntime } }).chrome?.runtime;
  expect(runtime?.id).toEqual(expect.any(String));
}

async function postPageHint(): Promise<void> {
  const poster = new BroadcastChannel(CHANNEL_NAME);
  posters.push(poster);
  poster.postMessage({
    msg: {
      name: PAGE_ON_MEDIA_HINTS,
      data: { hints: [{ url: "https://cdn.test/clip.mp4", kind: "file" }] },
    },
    channel: Channel.FromUntrustedInjectedToTrusted,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Model an extension reload: the old isolated world loses its runtime and calls start to throw. */
function reloadExtension(oldRuntime: SimulatedRuntime, newRuntime: SimulatedRuntime): void {
  oldRuntime.id = undefined;
  oldRuntime.behavior = "invalidated";
  activateRuntime(newRuntime);
}

afterEach(() => {
  for (const poster of posters.splice(0)) poster.close();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  const scope = globalThis as Record<string, unknown>;
  delete scope.chrome;
  delete scope.location;
  delete scope.__mediaDownloaderContentBridgeInstalled;
  delete scope.__mediaDownloaderBridgePing;
  delete scope.__mediaDownloaderHookInstalled;
});

describe("content bridge self-healing", () => {
  it("replaces a bridge whose extension context has gone away", async () => {
    const simulation = createSimulation();
    simulation.setPageHookInstalled(true);
    const oldRuntime = new SimulatedRuntime("extension-id");
    const newRuntime = new SimulatedRuntime("extension-id");
    installBridge(oldRuntime);
    expectBridgeAlive();

    reloadExtension(oldRuntime, newRuntime);
    // No message has failed yet: only the runtime identity tells us the bridge is orphaned.
    expect(bridgePing()).toBe(false);

    await new TabHealing(simulation.gateway).heal();

    expect(simulation.injectedFiles.flat()).toContain("content-script.js");
    expectBridgeAlive();
    await postPageHint();
    expect(newRuntime.messages.length).toBeGreaterThan(0);
  });

  it("re-injects after the old bridge has already seen the context fail", async () => {
    const simulation = createSimulation();
    simulation.setPageHookInstalled(true);
    const oldRuntime = new SimulatedRuntime("extension-id");
    const newRuntime = new SimulatedRuntime("extension-id");
    installBridge(oldRuntime);
    reloadExtension(oldRuntime, newRuntime);
    await postPageHint();
    expect(bridgePing()).toBe(false);

    await new TabHealing(simulation.gateway).heal();

    expect(simulation.injectedFiles.flat()).toContain("content-script.js");
    expectBridgeAlive();
    await postPageHint();
    expect(newRuntime.messages.length).toBeGreaterThan(0);
  });

  it("keeps the existing bridge when the runtime is still alive", () => {
    const simulation = createSimulation();
    simulation.setPageHookInstalled(true);
    const runtime = new SimulatedRuntime("extension-id");
    installBridge(runtime);
    const firstPing = (globalThis as { __mediaDownloaderBridgePing?: () => boolean }).__mediaDownloaderBridgePing;
    installBridge(runtime);
    expect((globalThis as { __mediaDownloaderBridgePing?: () => boolean }).__mediaDownloaderBridgePing).toBe(firstPing);
    expect(bridgePing()).toBe(true);
  });

  it("heals a tab whose page hook never installed", async () => {
    const simulation = createSimulation();
    simulation.setPageHookInstalled(false);
    const runtime = new SimulatedRuntime("extension-id");
    activateRuntime(runtime);

    await new TabHealing(simulation.gateway).heal();

    expect(simulation.injectedFiles.flat()).toContain("page-hook.js");
    expect(simulation.injectedFiles.flat()).toContain("content-script.js");
    expect(simulation.isPageHookInstalled()).toBe(true);
    expectBridgeAlive();
    expect(simulation.session.get(MARKER_KEY)).toBe(true);
  });

  it("does not heal twice in the same extension session", async () => {
    const simulation = createSimulation();
    simulation.setPageHookInstalled(false);
    activateRuntime(new SimulatedRuntime("extension-id"));
    await new TabHealing(simulation.gateway).heal();
    const injected = simulation.injectedFiles.flat().length;

    await new TabHealing(simulation.gateway).heal();

    expect(simulation.injectedFiles.flat().length).toBe(injected);
  });
});
