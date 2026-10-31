// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseMatchingMedia, restoreMatchingMedia } from "../src/extension/playback-coordination.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const controls = (element: HTMLMediaElement, isPlaying: boolean) => {
  Object.defineProperty(element, "paused", { configurable: true, value: !isPlaying });
  const pause = vi.fn();
  const play = vi.fn(async () => undefined);
  const load = vi.fn();
  element.pause = pause as unknown as () => void;
  element.play = play as unknown as () => Promise<void>;
  element.load = load as unknown as () => void;
  return { pause, play, load };
};

describe("playback connection coordination", () => {
  it("unloads the matching asset before transfer and restores its playback state afterward", () => {
    const matching = document.createElement("video");
    matching.src = "https://CDN.test/media/movie.mp4?download_token=old";
    matching.preload = "auto";
    matching.currentTime = 42.5;
    matching.playbackRate = 1.25;
    const matchingControls = controls(matching, true);

    const unrelated = document.createElement("video");
    unrelated.src = "https://cdn.test/media/other.mp4?download_token=old";
    unrelated.preload = "auto";
    const unrelatedControls = controls(unrelated, true);
    document.body.append(matching, unrelated);
    const target = "https://cdn.test/media/movie.mp4?download_token=new";

    expect(releaseMatchingMedia(target)).toBe(1);

    expect(matchingControls.pause).toHaveBeenCalledOnce();
    expect(matchingControls.load).toHaveBeenCalledOnce();
    expect(matching.hasAttribute("src")).toBe(false);
    expect(matching.preload).toBe("none");
    expect(unrelatedControls.pause).not.toHaveBeenCalled();
    expect(unrelatedControls.load).not.toHaveBeenCalled();
    expect(unrelated.preload).toBe("auto");

    expect(restoreMatchingMedia(target)).toBe(1);

    expect(matching.getAttribute("src")).toBe("https://CDN.test/media/movie.mp4?download_token=old");
    expect(matching.currentTime).toBe(42.5);
    expect(matching.playbackRate).toBe(1.25);
    expect(matching.preload).toBe("auto");
    expect(matchingControls.load).toHaveBeenCalledTimes(2);
    expect(matchingControls.play).toHaveBeenCalledOnce();
  });

  it("releases a paused source element inside an open shadow root without auto-resuming it", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const audio = document.createElement("audio");
    const source = document.createElement("source");
    source.src = "https://cdn.test/media/movie.mp4?download_token=old";
    audio.append(source);
    shadow.append(audio);
    const audioControls = controls(audio, false);
    const target = "https://cdn.test/media/movie.mp4?download_token=new";

    expect(releaseMatchingMedia(target)).toBe(1);
    expect(source.hasAttribute("src")).toBe(false);
    expect(audioControls.load).toHaveBeenCalledOnce();

    expect(restoreMatchingMedia(target)).toBe(1);
    expect(source.getAttribute("src")).toBe("https://cdn.test/media/movie.mp4?download_token=old");
    expect(audioControls.load).toHaveBeenCalledTimes(2);
    expect(audioControls.play).not.toHaveBeenCalled();
  });
});
