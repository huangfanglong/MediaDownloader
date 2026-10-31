/**
 * Download concurrency gate.
 *
 * Evidence: service worker `In` (analysis/pretty/service__main.js.pretty.js lines 21297-21381;
 * original artifact bytes ~503k). The original serialises concurrent downloads through this
 * queue and throttles site-adapter ("YouTube") work independently so it cannot starve other
 * downloads. Semantics reproduced exactly, including validation messages and the 1 s re-check
 * when only throttled work is pending.
 */
import { ok, type Result } from "../core/option.js";
import { userAbortReason, type TransferOutcome } from "../core/types.js";

export interface QueuedTask {
  readonly id: string;
  readonly isYoutube: boolean;
  /** Optional asset identity used to prevent overlapping connections to the same resource. */
  readonly connectionKey?: string;
  readonly resolve: (value: Result<TransferOutcome, string>) => void;
  readonly reject: (reason: unknown) => void;
  readonly task: () => Promise<Result<TransferOutcome, string>>;
}

export interface QueueStats {
  capacity: number;
  ytCapacity: number;
  running: number;
  ytRunning: number;
  pending: number;
}

/** Interval used to re-check a queue that is blocked only by throttled tasks. */
export const YOUTUBE_RECHECK_MS = 1000;

export class DownloadQueue {
  private running = 0;
  private ytRunning = 0;
  private readonly queue: QueuedTask[] = [];
  private readonly runningConnectionKeys = new Set<string>();
  private totalCapacity: number;
  private ytCapacity: number;
  private readonly ytDelay: number;
  private lastYoutubeSettledAt = 0;
  private schedulePending = false;

  constructor(totalCapacity: number, youtubeCapacity: number, youtubeDelayMs: number) {
    if (totalCapacity <= 0 || !Number.isFinite(totalCapacity)) {
      throw new Error("capacity must be a positive finite number");
    }
    if (youtubeCapacity <= 0 || !Number.isFinite(youtubeCapacity)) {
      throw new Error("youtube capacity must be a positive finite number");
    }
    if (totalCapacity < youtubeCapacity) {
      throw new Error("youtube capacity must be inferior or equal to capacity");
    }
    this.ytDelay = youtubeDelayMs;
    this.totalCapacity = totalCapacity;
    this.ytCapacity = youtubeCapacity;
  }

  getStats(): QueueStats {
    return {
      capacity: this.totalCapacity,
      ytCapacity: this.ytCapacity,
      running: this.running,
      ytRunning: this.ytRunning,
      pending: this.queue.length,
    };
  }

  /** Queue one transfer. Throttled or same-asset work may be skipped in favour of later work. */
  queueTask(
    task: () => Promise<Result<TransferOutcome, string>>,
    id: string,
    isYoutube: boolean,
    connectionKey?: string,
  ): Promise<Result<TransferOutcome, string>> {
    return new Promise<Result<TransferOutcome, string>>((resolve, reject) => {
      this.queue.push({ id, isYoutube, connectionKey, reject, resolve, task });
      this.schedule();
    });
  }

  /**
   * Cancel a task that has not started yet. Resolves it as an aborted (no partial file) outcome.
   * Returns false when the task is already running or unknown — the caller then aborts via the
   * worker channel instead.
   */
  cancelPendingTask(id: string): boolean {
    const index = this.queue.findIndex((task) => task.id === id);
    if (index < 0) return false;
    const [task] = this.queue.splice(index, 1);
    task?.resolve(
      ok({
        download_id: id,
        aborted_no_partial: true,
        ending_reason: userAbortReason(),
      }),
    );
    return true;
  }

  setTotalCapacity(capacity: number): void {
    if (capacity <= 0 || !Number.isFinite(capacity)) {
      throw new Error("capacity must be a positive finite number");
    }
    if (capacity < this.ytCapacity) {
      throw new Error("capacity must be superior or equal to youtube capacity");
    }
    this.totalCapacity = capacity;
    this.schedule();
  }

  setYoutubeCapacity(capacity: number): void {
    if (capacity <= 0 || !Number.isFinite(capacity)) {
      throw new Error("youtube capacity must be a positive finite number");
    }
    if (capacity > this.totalCapacity) {
      throw new Error("youtube capacity must be lower or equal to the total capacity");
    }
    this.ytCapacity = capacity;
    this.schedule();
  }

  private schedule(): void {
    while (this.running < this.totalCapacity) {
      const sinceLastYoutube = Date.now() - this.lastYoutubeSettledAt;
      const delayElapsed = this.ytCapacity > 1 || sinceLastYoutube > this.ytDelay;
      const youtubeMayRun = this.ytRunning < this.ytCapacity && delayElapsed;

      const index = this.queue.findIndex(
        (task) =>
          (!task.isYoutube || youtubeMayRun) &&
          (task.connectionKey === undefined || !this.runningConnectionKeys.has(task.connectionKey)),
      );
      if (index < 0) {
        // A connection key is released by the active task's finally handler, so only throttled
        // work needs a timer to become eligible.
        const youtubeBlocked = this.queue.some(
          (task) =>
            task.isYoutube &&
            (task.connectionKey === undefined || !this.runningConnectionKeys.has(task.connectionKey)),
        );
        if (youtubeBlocked && !this.schedulePending) {
          this.schedulePending = true;
          setTimeout(() => {
            this.schedulePending = false;
            this.schedule();
          }, YOUTUBE_RECHECK_MS);
        }
        return;
      }

      const [task] = this.queue.splice(index, 1);
      if (!task) return;
      this.running += 1;
      if (task.isYoutube) this.ytRunning += 1;
      if (task.connectionKey !== undefined) this.runningConnectionKeys.add(task.connectionKey);

      task
        .task()
        .then((value) => task.resolve(value))
        .catch((reason: unknown) => task.reject(reason))
        .finally(() => {
          this.running -= 1;
          if (task.isYoutube) {
            // Note: the original records the settle time, not the start time.
            this.lastYoutubeSettledAt = Date.now();
            this.ytRunning -= 1;
          }
          if (task.connectionKey !== undefined) this.runningConnectionKeys.delete(task.connectionKey);
          this.schedule();
        });
    }
  }
}
