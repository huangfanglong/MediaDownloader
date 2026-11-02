/**
 * Panel-scoped UI state that lives as long as the panel page does.
 *
 * The panel survives tab switches and SPA navigations, so anything it remembers per media item
 * must be bounded; a plain growing map would keep every hash the user ever touched for the whole
 * browser session.
 */
import { BoundedCache } from "./bounded-cache.js";

export interface MediaSelection {
  quality: string;
  format: string;
  source: string;
}

/** How many per-media selections are remembered before the least recently used one is dropped. */
export const MEDIA_SELECTION_CAP = 200;

/** Per-media quality/format/source choices, kept across row rebuilds and tab switches. */
export class MediaSelections {
  private readonly entries = new BoundedCache<string, MediaSelection>(
    MEDIA_SELECTION_CAP,
    Number.POSITIVE_INFINITY,
  );

  get(hash: string): MediaSelection | undefined {
    return this.entries.get(hash);
  }

  /** Merge one changed control into the media's stored choice. */
  save(hash: string, patch: Partial<MediaSelection>): void {
    const current = this.entries.get(hash);
    this.entries.set(hash, { quality: "0", format: "", source: "", ...current, ...patch });
  }

  get size(): number {
    return this.entries.size;
  }
}
