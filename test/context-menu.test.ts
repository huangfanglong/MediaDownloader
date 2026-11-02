import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { itemFromHint } from "../src/extension/content-script.js";
import {
  MAX_CONTEXT_MENU_MEDIA,
  MEDIA_MENU_PREFIX,
  ROOT_MENU_ID,
  composeContextMenuItems,
  contextMenuSignature,
} from "../src/extension/context-menu.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { MediaItem } from "../src/core/types.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";
import {
  FakeChannelHub,
  createFakeGateway,
  fetchMapFor,
  sniffDetails,
} from "./helpers/service-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A service wired to the fake browser, without calling `start()`. */
function buildService(fetchEntries: Record<string, string | Uint8Array> = {}) {
  const entries = fetchMapFor(fetchEntries);
  const gateway = createFakeGateway("https://site.test/watch", entries);
  const fetchImpl = createFetch(entries);
  const opfs = createFakeOpfs();
  const hub = new FakeChannelHub();
  const worker = new DownloadWorker({
    channel: hub.endpoint("worker"),
    fetchImpl,
    openRoot: async () => opfs.root,
  });
  worker.start();
  const service = new MediaDownloaderService({
    gateway,
    fetchImpl,
    opfsRoot: async () => opfs.root,
    downloadIdFactory: () => "download_context_menu",
    now: () => 1_700_000_000_000,
    workerClient: new WorkerClient({
      channel: hub.endpoint("service"),
      offscreen: gateway.offscreen,
      offscreenUrl: "chrome-extension://fake/factory/factory.html",
      readyTimeoutMs: 200,
    }),
  });
  return { service, gateway, opfs };
}

const menuTitles = (gateway: ReturnType<typeof buildService>["gateway"]): string[] =>
  gateway.contextMenuItems().map((item) => String(item.title));

const menuMediaIds = (gateway: ReturnType<typeof buildService>["gateway"]): string[] =>
  gateway
    .contextMenuItems()
    .map((item) => String(item.id))
    .filter((id) => id.startsWith(MEDIA_MENU_PREFIX));

/** A direct MP4 sniffed at the content-type level (large enough to pass the size filter). */
async function discoverMp4(
  gateway: ReturnType<typeof buildService>["gateway"],
  tabId: number,
  url: string,
): Promise<void> {
  await gateway.triggerResponseStarted(
    sniffDetails(url, "video/mp4", {
      tabId,
      responseHeaders: [
        { name: "content-type", value: "video/mp4" },
        { name: "content-length", value: "600000" },
      ],
    }),
  );
}

function mediaItem(hash: string): MediaItem {
  return {
    type: "http_playlist",
    hash,
    extension: "mp4",
    duration: "unknown",
    has_drm: false,
    cache: "default",
    discovery_timestamp_ms: 0,
  } as MediaItem;
}

describe("context menu composition", () => {
  it("lists media under a Download: header and caps the entries", () => {
    const media = new Map(
      Array.from({ length: MAX_CONTEXT_MENU_MEDIA + 3 }, (_, index) => [`h${index}`, mediaItem(`h${index}`)]),
    );
    const items = composeContextMenuItems({ media });
    expect(items[0]?.id).toBe(ROOT_MENU_ID);
    expect(items[1]).toMatchObject({ title: "Download:", enabled: false, parentId: ROOT_MENU_ID });
    const entries = items.filter((item) => item.id.startsWith(MEDIA_MENU_PREFIX));
    expect(entries).toHaveLength(MAX_CONTEXT_MENU_MEDIA);
    expect(entries[0]?.title).toBe("Media 1 (mp4)");
  });

  it("shows No Media without entries, and the signature tracks what users see", () => {
    const empty = composeContextMenuItems({ media: new Map() });
    expect(empty[1]?.title).toBe("No Media");
    expect(contextMenuSignature(empty)).toBe(contextMenuSignature(composeContextMenuItems({ media: new Map() })));
    const withMedia = composeContextMenuItems({ media: new Map([["h1", mediaItem("h1")]]) });
    expect(contextMenuSignature(withMedia)).not.toBe(contextMenuSignature(empty));
  });
});

describe("context menu lifetime", () => {
  it("starts from No Media and follows the active tab's discoveries", async () => {
    const { service, gateway } = buildService();
    await service.start();
    expect(menuTitles(gateway)).toEqual(["Media Downloader", "No Media"]);
    expect(gateway.contextMenuDuplicateIds()).toEqual([]);
    const bootRebuilds = gateway.contextMenuRebuildCount();

    await discoverMp4(gateway, 7, "https://cdn.test/direct.mp4");
    await vi.waitFor(() => expect(menuMediaIds(gateway)).toHaveLength(1));

    const hash = [...service.getEngine().mediaForTab(7).keys()][0];
    expect(menuMediaIds(gateway)).toEqual([`${MEDIA_MENU_PREFIX}${hash}`]);
    expect(menuTitles(gateway)).toEqual(["Media Downloader", "Download:", "Test Page.mp4"]);
    expect(gateway.contextMenuRebuildCount()).toBeGreaterThan(bootRebuilds);
    expect(gateway.contextMenuDuplicateIds()).toEqual([]);
    service.stop();
  });

  it("shows the media of the tab that is active now, not the boot tab", async () => {
    const { service, gateway } = buildService();
    await service.start();
    await discoverMp4(gateway, 7, "https://cdn.test/tab7.mp4");
    await discoverMp4(gateway, 9, "https://cdn.test/tab9.mp4");
    await vi.waitFor(() => expect(service.getSession().discovered.get(9)?.media.size).toBe(1));
    await vi.waitFor(() => expect(menuMediaIds(gateway)).toHaveLength(1));

    const tab7Hash = [...service.getEngine().mediaForTab(7).keys()][0] as string;
    expect(menuMediaIds(gateway)).toEqual([`${MEDIA_MENU_PREFIX}${tab7Hash}`]);

    gateway.triggerTabActivated(9);
    await vi.waitFor(() => {
      expect(service.getSession().current_win_tab.tab_id).toBe(9);
      const tab9Hash = [...service.getEngine().mediaForTab(9).keys()][0] as string;
      expect(menuMediaIds(gateway)).toEqual([`${MEDIA_MENU_PREFIX}${tab9Hash}`]);
    });
    service.stop();
  });

  it("clears the menu when the active tab navigates away", async () => {
    const { service, gateway } = buildService();
    await service.start();
    await discoverMp4(gateway, 7, "https://cdn.test/direct.mp4");
    await vi.waitFor(() => expect(menuMediaIds(gateway)).toHaveLength(1));

    gateway.triggerTabUpdated(7, { url: "https://site.test/another-page" });
    await vi.waitFor(() => expect(menuTitles(gateway)).toEqual(["Media Downloader", "No Media"]));
    service.stop();
  });

  it("drops the entry when the page dismisses that media", async () => {
    const { service, gateway } = buildService();
    await service.start();
    await discoverMp4(gateway, 7, "https://cdn.test/direct.mp4");
    await vi.waitFor(() => expect(menuMediaIds(gateway)).toHaveLength(1));
    const hash = [...service.getEngine().mediaForTab(7).keys()][0] as string;

    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DismissMedia, data: { tab_id: 7, media_hash: hash } },
      channel: Channel.FromContentToService,
    } as Envelope);
    await vi.waitFor(() => expect(menuMediaIds(gateway)).toHaveLength(0));
    service.stop();
  });

  it("does not rebuild the menu for a publish that changes nothing it shows", async () => {
    const { service, gateway } = buildService();
    await service.start();
    await discoverMp4(gateway, 7, "https://cdn.test/direct.mp4");
    await vi.waitFor(() => expect(menuMediaIds(gateway)).toHaveLength(1));
    const rebuilds = gateway.contextMenuRebuildCount();
    const writes = gateway.sessionWriteCount();

    // The same response again: the service publishes, but the menu content is identical.
    await discoverMp4(gateway, 7, "https://cdn.test/direct.mp4");
    await vi.waitFor(() => expect(gateway.sessionWriteCount()).toBeGreaterThan(writes));

    expect(gateway.contextMenuRebuildCount()).toBe(rebuilds);
    expect(gateway.contextMenuDuplicateIds()).toEqual([]);
    service.stop();
  });

  it("removes a leftover menu when boot finds no active tab, then recovers on activation", async () => {
    const { service, gateway } = buildService();
    gateway.contextMenus.create({ id: "stale-root", title: "left over from a previous worker" });
    vi.spyOn(gateway.tabs, "query").mockResolvedValue([]);
    await service.start();
    expect(gateway.contextMenuItems()).toHaveLength(0);
    expect(gateway.contextMenuRebuildCount()).toBeGreaterThanOrEqual(1);

    gateway.triggerTabActivated(7);
    await vi.waitFor(() => expect(menuTitles(gateway)).toEqual(["Media Downloader", "No Media"]));
    service.stop();
  });

  it("registers exactly one click listener, before boot's async work", async () => {
    const { service, gateway } = buildService();
    expect(gateway.contextMenuClickHandlerCount()).toBe(1);
    await service.start();
    expect(gateway.contextMenuClickHandlerCount()).toBe(1);
    await discoverMp4(gateway, 7, "https://cdn.test/direct.mp4");
    await vi.waitFor(() => expect(menuMediaIds(gateway)).toHaveLength(1));
    expect(gateway.contextMenuClickHandlerCount()).toBe(1);
    service.stop();
  });

  it("downloads the media behind a clicked menu entry and ignores other ids", async () => {
    const url = "https://cdn.test/clicked.mp4";
    const { service, gateway } = buildService({ [url]: "x".repeat(4_000) });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clicked-download");
    await service.start();

    const media = itemFromHint(
      { url, source: "resource-entry", kind: "file", referer: "https://site.test/watch" },
      "https://site.test/watch",
    ) as MediaItem;
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(media) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await vi.waitFor(() => expect(menuMediaIds(gateway)).toContain(`${MEDIA_MENU_PREFIX}${media.hash}`));

    await gateway.triggerContextMenuClick({ menuItemId: "media:missing" }, { id: 7 });
    await gateway.triggerContextMenuClick({ menuItemId: "media-downloader" }, { id: 7 });
    expect(gateway.downloadRequestsLog).toHaveLength(0);

    await gateway.triggerContextMenuClick({ menuItemId: `${MEDIA_MENU_PREFIX}${media.hash}` }, { id: 7 });
    await vi.waitFor(() => expect(gateway.downloadRequestsLog).toHaveLength(1));
    expect(gateway.downloadRequestsLog[0]).toMatchObject({
      filename: "Test Page.mp4",
      url: "blob:clicked-download",
      conflictAction: "uniquify",
    });
    service.stop();
  });
});
