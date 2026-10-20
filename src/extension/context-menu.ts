/**
 * Context-menu composition (pure).
 *
 * Evidence: 01-messaging-runtime.md §7 — the original builds a root menu plus a submenu with at
 * most 12 media entries (`em = 12`), each titled `<basename>.<extension>`, with a header entry
 * ("Download:" when media exists, "No Media" otherwise). Menu ids carry the media hash so the
 * click handler can find the item without re-scanning.
 */
import type { MediaItem, TabMeta } from "../core/types.js";
import { renderBasename } from "../naming/render.js";

/** Maximum number of media entries in the submenu (proven: `em = 12`). */
export const MAX_CONTEXT_MENU_MEDIA = 12;

export const ROOT_MENU_ID = "media-downloader";
export const SUBMENU_ID = "media-downloader-sub";
export const MEDIA_MENU_PREFIX = "media:";

export interface ContextMenuItem {
  id: string;
  title: string;
  contexts?: Array<"all" | "page" | "video" | "audio" | "link">;
  parentId?: string;
  enabled?: boolean;
}

export interface ContextMenuInput {
  media: ReadonlyMap<string, MediaItem>;
  meta?: TabMeta | undefined;
}

/** Build the menu item list for a tab. Empty media still yields the header ("No Media"). */
export function composeContextMenuItems(input: ContextMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const entries = [...input.media.values()].slice(0, MAX_CONTEXT_MENU_MEDIA);

  items.push({
    id: ROOT_MENU_ID,
    title: "Media Downloader",
    contexts: ["all"],
  });
  items.push({
    id: `${SUBMENU_ID}-header`,
    title: entries.length > 0 ? "Download:" : "No Media",
    parentId: ROOT_MENU_ID,
    contexts: ["all"],
    enabled: false,
  });

  entries.forEach((media, index) => {
    items.push({
      id: `${MEDIA_MENU_PREFIX}${media.hash}`,
      title: menuTitle(media, input.meta, index),
      parentId: ROOT_MENU_ID,
      contexts: ["all"],
    });
  });
  return items;
}

function menuTitle(media: MediaItem, meta: TabMeta | undefined, index: number): string {
  const extension = media.extension ?? media.demuxer ?? "media";
  if (!meta) return `Media ${index + 1} (${extension})`;
  try {
    const rendered = renderBasename(
      { title: media.title, filename: media.filename },
      { title: meta.title, url: meta.url?.href },
      meta.smartnaming_rule,
    );
    return `${rendered.basename}.${extension}`;
  } catch {
    return `Media ${index + 1} (${extension})`;
  }
}
