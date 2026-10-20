// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installContentBridge } from "../src/extension/content-script.js";
import { installPageHook, PAGE_ON_MEDIA_HINTS, PAGE_REQUEST_MEDIA_HINTS } from "../src/extension/page-hook.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import type { Envelope } from "../src/extension/gateways.js";

function fakeBroadcastChannel() {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const postMessage = vi.fn();
  return {
    channel: {
      postMessage,
      addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
        listeners.push(listener);
      },
      removeEventListener: () => undefined,
      close: () => undefined,
    } as unknown as BroadcastChannel,
    postMessage,
    emit: (data: unknown) => {
      for (const listener of listeners) listener({ data });
    },
  };
}

function fakeRuntime() {
  const sent: Envelope[] = [];
  return {
    sent,
    runtime: {
      sendMessage: async (message: Envelope) => {
        sent.push(message);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).BroadcastChannel;
});

describe("re-detection after idle / alt-tab (regression)", () => {
  it("re-reports the same media periodically instead of suppressing it forever", async () => {
    const { channel, emit } = fakeBroadcastChannel();
    const { sent, runtime } = fakeRuntime();
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const dispose = installContentBridge(runtime as never, "https://www.youtube.com/watch?v=abc", channel);
    const hint = { url: "https://rr1.googlevideo.com/videoplayback?id=1&itag=18", source: "player-response", kind: "file" };
    const pageMessage = {
      channel: Channel.FromUntrustedInjectedToTrusted,
      msg: { name: PAGE_ON_MEDIA_HINTS, data: { hints: [hint] } },
    };
    const onMediaCount = () => sent.filter((message) => message.msg.name === MSG.injectedToService.OnMedia).length;
    emit(pageMessage);
    expect(onMediaCount()).toBe(1);
    now += 1_000;
    emit(pageMessage);
    expect(onMediaCount()).toBe(1);
    now += 15_000;
    emit(pageMessage);
    expect(onMediaCount()).toBe(2);
    dispose();
  });

  it("requests fresh hints when playback resumes", () => {
    vi.useFakeTimers();
    const { channel, postMessage } = fakeBroadcastChannel();
    const { runtime } = fakeRuntime();
    const dispose = installContentBridge(runtime as never, "https://www.youtube.com/watch?v=abc", channel);
    const before = postMessage.mock.calls.length;
    document.body.innerHTML = `<video src="/clip.mp4"></video>`;
    document.querySelector("video")?.dispatchEvent(new Event("play", { bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(postMessage.mock.calls.length).toBeGreaterThan(before);
    dispose();
  });

  it("pushes hints from the page hook when a video starts playing", async () => {
    vi.useRealTimers();
    const fake = fakeBroadcastChannel();
    (globalThis as Record<string, unknown>).BroadcastChannel = function () {
      return fake.channel;
    } as unknown as typeof BroadcastChannel;
    delete (globalThis as Record<string, unknown>).__mediaDownloaderHookInstalled;
    installPageHook();
    document.body.innerHTML = `<video src="https://cdn.test/clip.mp4"></video>`;
    document.querySelector("video")?.dispatchEvent(new Event("play", { bubbles: true }));
    fake.emit({ channel: Channel.FromTrustedInjectedToUntrusted, msg: { name: PAGE_REQUEST_MEDIA_HINTS, data: null } });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const pushed = fake.postMessage.mock.calls.some(
      (call) => (call[0] as { msg?: { name?: string } }).msg?.name === PAGE_ON_MEDIA_HINTS,
    );
    expect(pushed).toBe(true);
  });

  it("survives an invalidated extension context without throwing", () => {
    delete (globalThis as Record<string, unknown>).__mediaDownloaderHookInstalled;
    const { channel, emit } = fakeBroadcastChannel();
    let calls = 0;
    const runtime = {
      sendMessage: () => {
        calls += 1;
        throw new Error("Extension context invalidated.");
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    const dispose = installContentBridge(runtime as never, "https://www.youtube.com/watch?v=abc", channel);
    const message = {
      channel: Channel.FromUntrustedInjectedToTrusted,
      msg: { name: PAGE_ON_MEDIA_HINTS, data: { hints: [{ url: "https://cdn.test/a.mp4", kind: "file", source: "video" }] } },
    };
    expect(() => emit(message)).not.toThrow();
    expect(() => emit(message)).not.toThrow();
    expect(calls).toBe(1);
    dispose();
  });

  it("still asks the page hook for hints over the bridge", () => {
    expect(PAGE_REQUEST_MEDIA_HINTS.length).toBeGreaterThan(0);
  });
});
