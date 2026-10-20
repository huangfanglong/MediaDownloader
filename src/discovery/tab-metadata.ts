/**
 * Page title / thumbnail extraction (original `Of`, pretty 11666-11708).
 *
 * The service worker injects this logic into the tab with `scripting.executeScript`
 * (`injectImmediately: true`) to fill `TabMeta.title` / `TabMeta.thumbnail_url` once a tab has a
 * discovered item. The DOM walk is reproduced here as a pure function over a `Document` so it can
 * be unit-tested with jsdom; the host keeps owning the injection.
 *
 * Evidence: analysis/evidence/02-detection-pipeline.md D33 (metadata) and the `Of` transcript in
 * 00/SPEC §4.6.
 */

/** Ordered thumbnail candidates: first attribute value found wins (original `Of`). */
export interface ThumbnailCandidate {
  selector: string;
  attribute: string;
}

/** Thumbnail candidates in the original order (D33; pretty 11668-11673). */
export const THUMBNAIL_CANDIDATES: readonly ThumbnailCandidate[] = [
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

/** Selector for the title fallback metas (original `Of`; pretty 11688). */
export const TITLE_METADATA_SELECTORS =
  "meta[name*=':title' i], meta[property*=':title' i]";

/** Options accepted by `extractTabMetadata`; `forceDocTitle` mirrors the smart-naming flag. */
export interface TabMetadataOptions {
  forceDocTitle?: boolean;
}

/** Result of the injected page script: both fields are already resolved/trimmed by the caller. */
export interface ExtractedTabMetadata {
  title?: string;
  /** Absolute thumbnail URL string; protocol-relative values are resolved against `https:`. */
  thumbnail?: string;
}

/**
 * Resolve a thumbnail candidate to an absolute URL string.
 * The original runs it through its URL parser (`de`); protocol-relative `//host/x` values are
 * normalised by prefixing `https:`. Unparseable values are dropped (Option None).
 */
function resolveThumbnail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.startsWith("//") ? `https:${value}` : value).href;
  } catch {
    return undefined;
  }
}

/**
 * Extract the page title and thumbnail exactly like the original injected script.
 *
 * Thumbnail: walk `THUMBNAIL_CANDIDATES` in order; inside each, take the first element whose
 * attribute is a string; stop as soon as a non-empty value was collected.
 *
 * Title: start with `document.title`. When `forceDocTitle` is false **or** the title is empty,
 * replace it with the first non-empty `meta[name*=':title' i]` / `meta[property*=':title' i]`
 * content. (So by default a meta title wins over `<title>`; `forceDocTitle` keeps `<title>`.)
 */
export function extractTabMetadata(
  document: Document,
  options: TabMetadataOptions = {},
): ExtractedTabMetadata {
  let thumbnail: string | undefined;
  for (const candidate of THUMBNAIL_CANDIDATES) {
    for (const element of document.querySelectorAll(candidate.selector)) {
      const value = element.getAttribute(candidate.attribute);
      if (typeof value === "string") {
        thumbnail = value;
        break;
      }
    }
    if (thumbnail) break;
  }

  let title = document.title;
  if (!options.forceDocTitle || !title) {
    for (const element of document.querySelectorAll(TITLE_METADATA_SELECTORS)) {
      const content = element.getAttribute("content");
      if (content) {
        title = content;
        break;
      }
    }
  }

  const result: ExtractedTabMetadata = {};
  if (title) result.title = title;
  const resolvedThumbnail = resolveThumbnail(thumbnail);
  if (resolvedThumbnail) result.thumbnail = resolvedThumbnail;
  return result;
}
