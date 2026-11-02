/**
 * Names to re-assert for blob downloads we started (`chrome.downloads.onDeterminingFilename`).
 *
 * The hook reports the blob URL on some Chrome builds and omits it on others, so a pending name is
 * matched by download id first, then by blob URL, and only then by order. The order fallback must
 * be FIFO: Chrome raises one filename event per download in the order the downloads were started,
 * and the old "most recent name wins" pick handed both racing downloads the same (last) name.
 */
export const MAX_PENDING_DOWNLOAD_NAMES = 100;

export interface PendingDownloadItem {
  /** Download id, when Chrome provides it on the filename event. */
  id?: number;
  /** Blob URL, when Chrome provides it on the filename event. */
  url?: string;
  /** Our own extension initiated the download (blob URLs only). */
  byExtensionId?: boolean;
  /** Name Chrome proposed; only logged, never used. */
  filename: string;
}

export class PendingDownloadNames {
  private readonly byUrl = new Map<string, string>();
  private readonly byId = new Map<number, string>();

  /** Register the name for a download about to be started from `url`. */
  addUrl(url: string, filename: string): void {
    this.byUrl.delete(url);
    this.byUrl.set(url, filename);
    trim(this.byUrl);
  }

  /** Register the name against the download id returned by `chrome.downloads.download`. */
  addId(id: number, filename: string): void {
    this.byId.delete(id);
    this.byId.set(id, filename);
    trim(this.byId);
  }

  /** Forget a download that never started (the browser call failed). */
  discardUrl(url: string): void {
    this.byUrl.delete(url);
  }

  /**
   * Best name for one filename event, consuming the entry it matched. Returns `undefined` when the
   * event does not belong to a pending download we started.
   */
  resolve(item: PendingDownloadItem): string | undefined {
    if (item.id !== undefined) {
      const byId = this.byId.get(item.id);
      if (byId !== undefined) {
        this.byId.delete(item.id);
        return byId;
      }
    }
    if (item.url !== undefined) {
      const byUrl = this.byUrl.get(item.url);
      if (byUrl !== undefined) {
        this.byUrl.delete(item.url);
        return byUrl;
      }
    }
    if (item.byExtensionId !== true) return undefined;
    // FIFO: the oldest still-pending name belongs to the earliest download, matching the order in
    // which Chrome raises these events.
    const oldest = this.byUrl.keys().next();
    if (oldest.done === true) return undefined;
    const filename = this.byUrl.get(oldest.value);
    this.byUrl.delete(oldest.value);
    return filename;
  }

  get size(): number {
    return this.byUrl.size + this.byId.size;
  }
}

function trim<Key>(map: Map<Key, string>): void {
  while (map.size > MAX_PENDING_DOWNLOAD_NAMES) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
