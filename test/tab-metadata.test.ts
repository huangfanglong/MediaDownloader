// @vitest-environment jsdom

/**
 * Page title/thumbnail extraction parity tests (original `Of`, D33).
 *
 * The logic is the exact DOM walk the service worker injects into the tab, so these tests run
 * under jsdom and assert the recovered candidate order and the `//`→`https:` resolution.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  THUMBNAIL_CANDIDATES,
  TITLE_METADATA_SELECTORS,
  extractTabMetadata,
} from "../src/discovery/tab-metadata.js";

/** Recovered candidate list, verbatim from service/main.js pretty 11668-11673. */
const FIXTURE_THUMBNAIL_CANDIDATES = [
  { selector: "#vp-preview", attribute: "data-thumb" },
  { selector: "video", attribute: "poster" },
  {
    selector: "meta[name*=':image' i], meta[property*=':image' i]",
    attribute: "content",
  },
  {
    selector: "link[rel='image_src'], link[rel='thumbnail'], link[as='image']",
    attribute: "href",
  },
];

function setupPage(page: {
  head?: string;
  body?: string;
  title?: string;
}): void {
  document.head.innerHTML = page.head ?? "";
  document.body.innerHTML = page.body ?? "";
  document.title = page.title ?? "";
}

beforeEach(() => {
  setupPage({});
});

describe("recovered DOM constants", () => {
  it("exports the thumbnail candidates in the original order", () => {
    expect(THUMBNAIL_CANDIDATES.map((candidate) => ({ ...candidate }))).toEqual(
      FIXTURE_THUMBNAIL_CANDIDATES,
    );
  });

  it("exports the title-metadata selector", () => {
    expect(TITLE_METADATA_SELECTORS).toBe(
      "meta[name*=':title' i], meta[property*=':title' i]",
    );
  });
});

describe("thumbnail extraction order", () => {
  it("prefers #vp-preview[data-thumb] over every other candidate", () => {
    setupPage({
      head: `
        <meta name="twitter:image" content="https://cdn/meta.jpg">
        <link rel="image_src" href="https://cdn/link.jpg">
      `,
      body: `
        <div id="vp-preview" data-thumb="https://cdn/vp.jpg"></div>
        <video poster="https://cdn/poster.jpg"></video>
      `,
    });
    expect(extractTabMetadata(document).thumbnail).toBe("https://cdn/vp.jpg");
  });

  it("falls back to video[poster]", () => {
    setupPage({
      head: `<meta name="twitter:image" content="https://cdn/meta.jpg">`,
      body: `<video poster="https://cdn/poster.jpg"></video>`,
    });
    expect(extractTabMetadata(document).thumbnail).toBe(
      "https://cdn/poster.jpg",
    );
  });

  it("falls back to meta[name*=':image'] / meta[property*=':image']", () => {
    setupPage({
      head: `<meta property="og:image" content="https://cdn/og.jpg">`,
      body: `<video></video>`,
    });
    expect(extractTabMetadata(document).thumbnail).toBe("https://cdn/og.jpg");

    setupPage({
      head: `<meta name="twitter:image" content="https://cdn/tw.jpg">`,
    });
    expect(extractTabMetadata(document).thumbnail).toBe("https://cdn/tw.jpg");
  });

  it.each([
    [
      "image_src",
      `<link rel="image_src" href="https://cdn/a.jpg">`,
      "https://cdn/a.jpg",
    ],
    [
      "thumbnail",
      `<link rel="thumbnail" href="https://cdn/b.jpg">`,
      "https://cdn/b.jpg",
    ],
    [
      "as=image",
      `<link as="image" href="https://cdn/c.jpg">`,
      "https://cdn/c.jpg",
    ],
  ])("falls back to link rel/as %s", (_label, linkMarkup, expected) => {
    setupPage({ head: linkMarkup });
    expect(extractTabMetadata(document).thumbnail).toBe(expected);
  });

  it("resolves protocol-relative thumbnails against https:", () => {
    setupPage({
      body: `<video poster="//cdn.example.com/poster.jpg"></video>`,
    });
    expect(extractTabMetadata(document).thumbnail).toBe(
      "https://cdn.example.com/poster.jpg",
    );

    setupPage({
      head: `<link rel="image_src" href="//cdn.example.com/link.jpg">`,
    });
    expect(extractTabMetadata(document).thumbnail).toBe(
      "https://cdn.example.com/link.jpg",
    );
  });

  it("skips an empty attribute value and continues with the next candidate", () => {
    setupPage({
      body: `
        <div id="vp-preview" data-thumb=""></div>
        <video poster="https://cdn/poster.jpg"></video>
      `,
    });
    expect(extractTabMetadata(document).thumbnail).toBe(
      "https://cdn/poster.jpg",
    );
  });

  it("drops an unparseable first candidate instead of falling through", () => {
    setupPage({
      body: `
        <div id="vp-preview" data-thumb="::::"></div>
        <video poster="https://cdn/poster.jpg"></video>
      `,
    });
    expect(extractTabMetadata(document).thumbnail).toBeUndefined();
  });

  it("returns undefined when no candidate yields a value", () => {
    setupPage({ head: `<title>Only a title</title>` });
    expect(extractTabMetadata(document).thumbnail).toBeUndefined();
  });
});

describe("title extraction", () => {
  it("by default lets a meta :title win over document.title", () => {
    setupPage({
      head: `<meta name="twitter:title" content="Meta Title">`,
      title: "Document Title",
    });
    expect(extractTabMetadata(document).title).toBe("Meta Title");
  });

  it("uses document.title when no meta :title exists", () => {
    setupPage({ title: "Document Title" });
    expect(extractTabMetadata(document).title).toBe("Document Title");
  });

  it("forceDocTitle keeps document.title when it is non-empty", () => {
    setupPage({
      head: `<meta property="og:title" content="Meta Title">`,
      title: "Document Title",
    });
    expect(extractTabMetadata(document, { forceDocTitle: true }).title).toBe(
      "Document Title",
    );
  });

  it("forceDocTitle falls back to the meta title when document.title is empty", () => {
    setupPage({
      head: `<meta property="og:title" content="Meta Title">`,
      title: "",
    });
    expect(extractTabMetadata(document, { forceDocTitle: true }).title).toBe(
      "Meta Title",
    );
  });

  it("skips empty meta content and uses the next meta", () => {
    setupPage({
      head: `
        <meta name="og:title" content="">
        <meta property="og:title" content="Second Title">
      `,
      title: "",
    });
    expect(extractTabMetadata(document).title).toBe("Second Title");
  });

  it("omits the title when both the document title and metas are empty", () => {
    setupPage({ title: "" });
    expect(extractTabMetadata(document).title).toBeUndefined();
  });
});
