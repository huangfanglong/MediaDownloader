// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Channel } from "../src/protocol/channels.js";
import { encode } from "../src/protocol/serde.js";
import { REBUILD_MESSAGES } from "../src/protocol/rebuild-messages.js";

const row = {
  hash: "media_hash_1",
  type: "http_playlist",
  label: "clip.mp4",
  has_drm: false,
  variants: [{ index: 0, label: "MP4" }],
  sources: [{ value: "fmt", label: "FMT" }],
};

const snapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  tab_id: 7,
  page_url: "https://site.test/watch",
  page_title: "Watch page",
  media: [row],
  downloading: [],
  notifications: [],
  ...overrides,
});

interface PanelHarness {
  listeners: Array<(message: unknown) => void>;
  executeScript: ReturnType<typeof vi.fn>;
  list: HTMLElement;
  title: HTMLElement;
}

/** Load the real panel script against a minimal stand-in for the Chrome runtime. */
async function bootPanel(): Promise<PanelHarness> {
  vi.useFakeTimers();
  vi.resetModules();
  document.body.innerHTML = `
    <ul id="media-list"></ul>
    <div id="empty"></div>
    <div id="status">
      <span id="status-label"></span><span id="status-detail"></span>
      <div id="status-track"><div id="status-fill"></div></div>
    </div>
    <div id="page-title"></div>
    <button id="cancel-button"></button>
  `;
  const listeners: Array<(message: unknown) => void> = [];
  const executeScript = vi.fn(async () => [] as Array<{ result?: unknown }>);
  (globalThis as never as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: async () => undefined,
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) },
    },
    scripting: { executeScript },
  };
  await import("../src/extension/panel/panel.js");
  await vi.advanceTimersByTimeAsync(0);
  return {
    listeners,
    executeScript,
    list: document.getElementById("media-list") as HTMLElement,
    title: document.getElementById("page-title") as HTMLElement,
  };
}

function deliver(panel: PanelHarness, data: Record<string, unknown>): void {
  for (const listener of panel.listeners) {
    listener({
      channel: Channel.FromServiceToContent,
      msg: { name: REBUILD_MESSAGES.SessionSnapshot, data: encode(data) },
    });
  }
}

describe("panel DOM boundary", () => {
  it("keeps the last good rows when a snapshot has an unexpected shape", async () => {
    const panel = await bootPanel();
    deliver(panel, snapshot());
    expect(panel.title.textContent).toBe("Watch page");
    expect(panel.list.children).toHaveLength(1);

    expect(() => deliver(panel, { media: "oops", downloading: [], notifications: [] })).not.toThrow();
    expect(panel.title.textContent).toBe("Watch page");
    expect(panel.list.children).toHaveLength(1);
    vi.useRealTimers();
  });

  it("renders page-supplied strings as text, never as markup", async () => {
    const panel = await bootPanel();
    deliver(
      panel,
      snapshot({
        page_title: "<b>bold</b>",
        media: [{ ...row, label: '<img src=x onerror="alert(1)">.mp4' }],
      }),
    );
    expect(panel.title.querySelector("b")).toBeNull();
    expect(panel.title.textContent).toBe("<b>bold</b>");
    expect(panel.list.querySelector("img")).toBeNull();
    expect(panel.list.querySelector(".media-label")?.textContent).toBe('<img src=x onerror="alert(1)">.mp4');
    vi.useRealTimers();
  });

  it("shows a determinate track when the snapshot includes a percentage", async () => {
    const panel = await bootPanel();
    deliver(
      panel,
      snapshot({ downloading: [{ download_id: "download_known", status: "downloading", percent: 42 }] }),
    );

    const track = document.getElementById("status-track") as HTMLElement;
    const fill = document.getElementById("status-fill") as HTMLElement;
    expect(track.hidden).toBe(false);
    expect(track.getAttribute("aria-valuenow")).toBe("42");
    expect(fill.style.width).toBe("42%");
    vi.useRealTimers();
  });

  it("keeps the progress track hidden while the transfer total is unknown", async () => {
    const panel = await bootPanel();
    deliver(panel, snapshot({ downloading: [{ download_id: "download_unknown", status: "downloading" }] }));

    expect((document.getElementById("status-track") as HTMLElement).hidden).toBe(true);
    vi.useRealTimers();
  });

  it("stops measuring page quality after a bounded number of attempts", async () => {
    const panel = await bootPanel();
    panel.executeScript.mockClear();
    for (let second = 0; second < 60; second += 2) {
      deliver(panel, snapshot());
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(panel.executeScript.mock.calls.length).toBeGreaterThan(0);
    expect(panel.executeScript.mock.calls.length).toBeLessThanOrEqual(3);
    const options = panel.executeScript.mock.calls[0]?.[0] as {
      target?: { tabId?: number; allFrames?: boolean };
      world?: string;
      func?: unknown;
    };
    expect(options.target?.tabId).toBe(7);
    expect(options.target?.allFrames).toBe(true);
    expect(options.world).toBe("MAIN");
    // self-contained probe function: it runs in the page, not in the panel
    expect(typeof options.func).toBe("function");
    vi.useRealTimers();
  });
});
