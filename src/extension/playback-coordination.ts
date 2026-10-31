/**
 * Explicitly release a direct asset's playback connection before downloading it.
 *
 * Both exported functions are serialised by chrome.scripting. Their executable bodies must remain
 * self-contained: imports and module-scope values are unavailable when Chrome invokes them.
 */
interface SavedSource {
  element: HTMLSourceElement;
  src: string | null;
}

interface SavedPlayback {
  element: HTMLMediaElement;
  src: string | null;
  sources: SavedSource[];
  currentTime: number;
  wasPlaying: boolean;
  preload: HTMLMediaElement["preload"];
  autoplay: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  muted: boolean;
  volume: number;
  loop: boolean;
}

type PlaybackStore = Map<string, SavedPlayback[]>;

/** Detach matching sources and call load(), which aborts the element's active media fetch. */
export function releaseMatchingMedia(targetUrl: string): number {
  const assetKey = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    try {
      const url = new URL(raw, document.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      return `${url.origin}${url.pathname}`.toLowerCase();
    } catch {
      return undefined;
    }
  };
  const targetKey = assetKey(targetUrl);
  if (targetKey === undefined) return 0;

  const root = globalThis as typeof globalThis & {
    __mediaDownloaderPlaybackStore__?: PlaybackStore;
  };
  const store = root.__mediaDownloaderPlaybackStore__ ?? new Map<string, SavedPlayback[]>();
  root.__mediaDownloaderPlaybackStore__ = store;
  const saved = store.get(targetKey) ?? [];

  const media: HTMLMediaElement[] = [];
  const visit = (rootNode: Document | ShadowRoot): void => {
    for (const element of Array.from(rootNode.querySelectorAll("video, audio"))) {
      media.push(element as HTMLMediaElement);
    }
    for (const element of Array.from(rootNode.querySelectorAll("*"))) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);

  let released = 0;
  for (const element of media) {
    const sources = Array.from(element.querySelectorAll("source"));
    const candidates = [element.currentSrc, element.src, ...sources.map((source) => source.src)];
    if (!candidates.some((candidate) => assetKey(candidate) === targetKey)) continue;
    if (saved.some((state) => state.element === element)) continue;

    saved.push({
      element,
      src: element.getAttribute("src"),
      sources: sources.map((source) => ({ element: source, src: source.getAttribute("src") })),
      currentTime: element.currentTime,
      wasPlaying: !element.paused && !element.ended,
      preload: element.preload,
      autoplay: element.autoplay,
      playbackRate: element.playbackRate,
      defaultPlaybackRate: element.defaultPlaybackRate,
      muted: element.muted,
      volume: element.volume,
      loop: element.loop,
    });
    element.pause();
    element.removeAttribute("src");
    for (const source of sources) source.removeAttribute("src");
    element.preload = "none";
    element.load();
    released += 1;
  }

  if (saved.length > 0) store.set(targetKey, saved);
  return released;
}

/** Restore sources and playback state after the competing transfer has completely settled. */
export function restoreMatchingMedia(targetUrl: string): number {
  const assetKey = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    try {
      const url = new URL(raw, document.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      return `${url.origin}${url.pathname}`.toLowerCase();
    } catch {
      return undefined;
    }
  };
  const targetKey = assetKey(targetUrl);
  if (targetKey === undefined) return 0;

  const root = globalThis as typeof globalThis & {
    __mediaDownloaderPlaybackStore__?: PlaybackStore;
  };
  const store = root.__mediaDownloaderPlaybackStore__;
  const saved = store?.get(targetKey);
  if (store === undefined || saved === undefined) return 0;
  store.delete(targetKey);

  let restored = 0;
  for (const state of saved) {
    try {
      const { element } = state;
      if (state.src !== null) element.setAttribute("src", state.src);
      for (const source of state.sources) {
        if (source.src !== null) source.element.setAttribute("src", source.src);
      }
      element.preload = state.preload;
      element.autoplay = state.autoplay;
      element.defaultPlaybackRate = state.defaultPlaybackRate;
      element.playbackRate = state.playbackRate;
      element.muted = state.muted;
      element.volume = state.volume;
      element.loop = state.loop;
      if (element.isConnected) {
        element.load();
        if (Number.isFinite(state.currentTime)) element.currentTime = state.currentTime;
        if (state.wasPlaying) {
          const playback = element.play();
          if (playback !== undefined) void playback.catch(() => undefined);
        }
      }
      restored += 1;
    } catch {
      // A page can replace its player during a long transfer; leave that replacement untouched.
    }
  }
  return restored;
}
