/**
 * Chooses when observable session state reaches the panel and when it is written to storage.
 *
 * Progress updates arrive at chunk rate (the browser-side ranged path sees one per 2 MiB) while
 * durable state changes are rare. `MediaDownloaderService.publish()` used to do both in one call,
 * so every progress event re-encoded the entire session and wrote it to `storage.session`
 * Progress now goes through `progress()`: it may push the panel and checkpoint the
 * session, but only at bounded intervals. Structural changes keep using the awaited
 * `structural()`, which writes immediately and resolves only after the write that includes them.
 *
 * There are no timers here on purpose: the decisions are taken on the events that arrive, so the
 * class cannot keep an MV3 worker alive or fire after shutdown, and tests stay deterministic with
 * an injected clock. A stalled transfer simply stops updating; its start/finish writes still land.
 */

/** Minimum gap between progress-driven panel pushes (the snapshot itself has its own throttle). */
export const PROGRESS_UI_INTERVAL_MS = 250;
/** How stale a restart may see progress: the session is checkpointed at most this often. */
export const PROGRESS_PERSIST_INTERVAL_MS = 2_000;

export interface SessionPublisherOptions {
  now: () => number;
  /** Push the current panel snapshot. Cheap and UI-only. */
  pushUi: () => void;
  /** Encode and persist the session. */
  persist: () => Promise<void>;
  uiIntervalMs?: number;
  persistIntervalMs?: number;
}

export class SessionPublisher {
  private readonly now: () => number;
  private readonly pushUi: () => void;
  private readonly persist: () => Promise<void>;
  private readonly uiIntervalMs: number;
  private readonly persistIntervalMs: number;

  private lastUiAt = Number.NEGATIVE_INFINITY;
  private lastPersistAt = Number.NEGATIVE_INFINITY;
  private persistTail: Promise<void> = Promise.resolve();
  private persistScheduled = false;
  private persistDirty = false;

  constructor(options: SessionPublisherOptions) {
    this.now = options.now;
    this.pushUi = options.pushUi;
    this.persist = options.persist;
    this.uiIntervalMs = options.uiIntervalMs ?? PROGRESS_UI_INTERVAL_MS;
    this.persistIntervalMs = options.persistIntervalMs ?? PROGRESS_PERSIST_INTERVAL_MS;
  }

  /** A durable change: show it and write it now, even if a previous write is still in flight. */
  async structural(): Promise<void> {
    this.lastUiAt = this.now();
    this.pushUi();
    await this.requestPersist();
    this.lastPersistAt = this.now();
  }

  /** An ephemeral update: refresh the panel at most every `uiIntervalMs`, checkpoint storage. */
  progress(): void {
    const now = this.now();
    if (now - this.lastUiAt >= this.uiIntervalMs) {
      this.lastUiAt = now;
      this.pushUi();
    }
    if (now - this.lastPersistAt >= this.persistIntervalMs) {
      this.lastPersistAt = now;
      void this.requestPersist();
    }
  }

  /**
   * Single-flight persistence: concurrent callers share one write, and every caller that marked the
   * state dirty gets one trailing write with the latest state before its promise resolves.
   */
  private requestPersist(): Promise<void> {
    this.persistDirty = true;
    if (!this.persistScheduled) {
      this.persistScheduled = true;
      this.persistTail = this.runPersistLoop();
    }
    return this.persistTail;
  }

  private async runPersistLoop(): Promise<void> {
    try {
      while (this.persistDirty) {
        this.persistDirty = false;
        try {
          await this.persist();
        } catch {
          // `persistSession` already swallows storage errors; never let the queue die on one.
        }
      }
    } finally {
      this.persistScheduled = false;
    }
  }
}
