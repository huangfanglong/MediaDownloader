/**
 * MPD documents are XML, so character references in text nodes and attribute values must be
 * decoded before the values are used. URLs in particular lose their query pairs (`&amp;` must
 * become `&`, `&#38;` must not leak a `#`), and attribute consumers (ids, languages) expect the
 * characters the document actually represents.
 */
import { describe, expect, it } from "vitest";
import { parseMpd, type MpdManifest } from "../src/manifests/dash.js";

const MPD_URL = new URL("https://cdn.test/manifest.mpd");

const videoMpd = (baseUrl: string): string => `<MPD type="static" mediaPresentationDuration="PT10S"><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">
    <Representation id="v1" codecs="avc1.4d401f" width="1280" height="720" bandwidth="1000000">
      <BaseURL>${baseUrl}</BaseURL>
    </Representation>
  </AdaptationSet>
</Period></MPD>`;

function parse(text: string): MpdManifest {
  const result = parseMpd(text, MPD_URL);
  if (result.tag !== "Ok") throw new Error(`parse failed: ${result.error.message}`);
  return result.value;
}

describe("MPD character reference decoding", () => {
  it("decodes the predefined entities in BaseURL text", () => {
    const manifest = parse(videoMpd("https://cdn.test/seg?oe=1&amp;efg=x"));
    expect(manifest.video[0]?.url.href).toBe("https://cdn.test/seg?oe=1&efg=x");
  });

  it("decodes decimal and hexadecimal character references in BaseURL text", () => {
    expect(parse(videoMpd("https://cdn.test/seg?oe=1&#38;efg=x")).video[0]?.url.href).toBe(
      "https://cdn.test/seg?oe=1&efg=x",
    );
    expect(parse(videoMpd("https://cdn.test/seg?oe=1&#x26;efg=x")).video[0]?.url.href).toBe(
      "https://cdn.test/seg?oe=1&efg=x",
    );
  });

  it("decodes entities in attribute values", () => {
    const manifest = parse(`<MPD type="static" mediaPresentationDuration="PT10S"><Period>
      <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en&amp;US">
        <Representation id="a&amp;1&amp;b" codecs="mp4a.40.2" bandwidth="64000">
          <BaseURL>https://cdn.test/a.m4a</BaseURL>
        </Representation>
      </AdaptationSet>
    </Period></MPD>`);
    expect(manifest.audio[0]?.id).toBe("a&1&b");
    expect(manifest.audio[0]?.language).toBe("en&US");
  });

  it("keeps CDATA content literal", () => {
    const manifest = parse(videoMpd("<![CDATA[https://cdn.test/seg?oe=1&efg=x]]>"));
    expect(manifest.video[0]?.url.href).toBe("https://cdn.test/seg?oe=1&efg=x");
  });

  it("decodes exactly once so nested reference text stays literal", () => {
    const reference = parse(videoMpd("https://cdn.test/seg?x=&amp;lt;")).video[0]?.url.href ?? "";
    expect(reference).toContain("&lt;");
    expect(reference).not.toContain("<");
  });

  it("leaves unknown or malformed references untouched", () => {
    const reference = parse(videoMpd("https://cdn.test/seg?x=&unknown;&y=&amp;")).video[0]?.url.href ?? "";
    expect(reference).toContain("&unknown;");
    expect(reference).toMatch(/[?&]y=&/u);
  });

  it("resolves an escaped BaseURL passed down from a parent element", () => {
    const manifest = parse(`<MPD type="static" mediaPresentationDuration="PT10S">
      <BaseURL>https://cdn.test/root/</BaseURL>
      <Period>
        <BaseURL>sub/?a=1&amp;b=2</BaseURL>
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <Representation id="v1" codecs="avc1.4d401f" width="1280" height="720" bandwidth="1000000" />
        </AdaptationSet>
      </Period>
    </MPD>`);
    expect(manifest.video[0]?.url.href).toBe("https://cdn.test/root/sub/?a=1&b=2");
  });
});
