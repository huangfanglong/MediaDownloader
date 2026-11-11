/**
 * Adapter-coverage invariant for the initiator suppression table.
 *
 * `BLOCKED_INITIATOR_HOSTS` is a detection kill-switch: a response whose initiator is on the list
 * is dropped before classification on the assumption that the site's page adapter discovers media
 * instead. A listed host with no shipped page adapter therefore has NO discovery path at all —
 * network sniffing suppressed, page hook absent. Every suppression must be covered by a shipped
 * page adapter (youtube, instagram, bilibili are shipped; bilibili deliberately stays
 * unsuppressed because its adapter does not own every response there).
 */
import { describe, expect, it } from "vitest";
import { BLOCKED_INITIATOR_HOSTS } from "../src/discovery/classify.js";
import { makeResponseStartedEvent } from "./fixtures/detection.js";
import { makeEngine } from "./helpers/discovery-harness.js";
import { createHarness, fmp4MediaPlaylist, sniffDetails } from "./helpers/service-harness.js";

const FIXTURE = {
  masterUrl: "https://cdn.test/master.m3u8",
  mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
  mediaPlaylist: fmp4MediaPlaylist,
  segmentPrefix: "https://cdn.test/1080/",
  segments: 3,
  initBytes: "INIT",
};

describe("suppressed initiator hosts (D25)", () => {
  it("suppresses exactly the hosts covered by a shipped page adapter", () => {
    expect([...BLOCKED_INITIATOR_HOSTS]).toEqual(["youtube.com", "instagram.com"]);
  });

  it("still suppresses the covered hosts", () => {
    const engine = makeEngine();
    for (const hostname of ["www.youtube.com", "www.instagram.com"]) {
      expect(engine.onResponseStarted(makeResponseStartedEvent({ initiator: `https://${hostname}/watch` }))).toBeNull();
    }
  });
});

describe("hosts without a shipped adapter must stay detectable by sniffing", () => {
  it.each([
    "ok.ru", "vk.com", "vk.ru", "vkvideo.ru", "canva.com",
    "iq.com", "vimeo.com", "kick.com", "javrank.com",
  ])("detects a direct mp4 response initiated by %j", (hostname) => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({ initiator: `https://${hostname}/watch` }),
    );
    expect(item).not.toBeNull();
  });
});

describe("full pipeline", () => {
  it("discovers a HLS master sniffed for a page on an adapter-less host", async () => {
    const harness = createHarness(FIXTURE);
    await harness.service.start();
    harness.gateway.triggerSendHeaders({
      requestId: "req-master",
      url: FIXTURE.masterUrl,
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [{ name: "referer", value: "https://kick.com/watch" }],
    });
    await harness.gateway.triggerResponseStarted(
      sniffDetails(FIXTURE.masterUrl, "application/vnd.apple.mpegurl", { initiator: "https://kick.com/watch" }),
    );
    const discovered = harness.service.getSession().discovered.get(7);
    const item = [...(discovered?.media.values() ?? [])][0];
    expect(item).toBeDefined();
    await harness.service.stop();
  });
});
