import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadQueue, YOUTUBE_RECHECK_MS } from "../src/transfer/queue.js";
import { ok, type Result } from "../src/core/option.js";
import type { TransferOutcome } from "../src/core/types.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const outcome = (name: string): Result<TransferOutcome, string> => ok({ path: name } as TransferOutcome);

/** Let the queue's promise chain (`then`/`catch`/`finally` + re-schedule) run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("DownloadQueue validation (proven error strings)", () => {
  it("rejects non-positive or non-finite capacities", () => {
    expect(() => new DownloadQueue(0, 1, 0)).toThrow("capacity must be a positive finite number");
    expect(() => new DownloadQueue(Number.POSITIVE_INFINITY, 1, 0)).toThrow(
      "capacity must be a positive finite number",
    );
    expect(() => new DownloadQueue(2, 0, 0)).toThrow(
      "youtube capacity must be a positive finite number",
    );
    expect(() => new DownloadQueue(1, 2, 0)).toThrow(
      "youtube capacity must be inferior or equal to capacity",
    );
  });

  it("validates capacity setters against each other", () => {
    const queue = new DownloadQueue(4, 2, 6000);
    expect(() => queue.setTotalCapacity(1)).toThrow(
      "capacity must be superior or equal to youtube capacity",
    );
    expect(() => queue.setYoutubeCapacity(5)).toThrow(
      "youtube capacity must be lower or equal to the total capacity",
    );
    expect(() => queue.setTotalCapacity(-1)).toThrow("capacity must be a positive finite number");
    expect(() => queue.setYoutubeCapacity(0)).toThrow(
      "youtube capacity must be a positive finite number",
    );
  });
});

describe("DownloadQueue scheduling", () => {
  it("runs up to capacity concurrently and keeps FIFO order", async () => {
    const queue = new DownloadQueue(2, 2, 6000);
    const started: string[] = [];
    const a = deferred<Result<TransferOutcome, string>>();
    const b = deferred<Result<TransferOutcome, string>>();
    const c = deferred<Result<TransferOutcome, string>>();

    const pa = queue.queueTask(async () => {
      started.push("a");
      return a.promise;
    }, "a", false);
    const pb = queue.queueTask(async () => {
      started.push("b");
      return b.promise;
    }, "b", false);
    const pc = queue.queueTask(async () => {
      started.push("c");
      return c.promise;
    }, "c", false);

    await flush();
    expect(started).toEqual(["a", "b"]);
    expect(queue.getStats()).toMatchObject({ running: 2, pending: 1 });

    a.resolve(outcome("a"));
    await pa;
    await flush();
    expect(started).toEqual(["a", "b", "c"]);

    b.resolve(outcome("b"));
    c.resolve(outcome("c"));
    await Promise.all([pb, pc]);
    await flush();
    expect(queue.getStats()).toMatchObject({ running: 0, pending: 0 });
  });

  it("serializes transfers with the same connection key despite spare capacity", async () => {
    const queue = new DownloadQueue(3, 3, 6000);
    const first = deferred<Result<TransferOutcome, string>>();
    const second = deferred<Result<TransferOutcome, string>>();
    const started: string[] = [];

    const p1 = queue.queueTask(async () => {
      started.push("first");
      return first.promise;
    }, "first", false, "https://cdn.test/movie.mp4");
    const p2 = queue.queueTask(async () => {
      started.push("second");
      return second.promise;
    }, "second", false, "https://cdn.test/movie.mp4");

    await flush();
    expect(started).toEqual(["first"]);
    expect(queue.getStats()).toMatchObject({ running: 1, pending: 1 });

    first.resolve(outcome("first"));
    await p1;
    await flush();
    expect(started).toEqual(["first", "second"]);

    second.resolve(outcome("second"));
    await p2;
    await flush();
    expect(queue.getStats()).toMatchObject({ running: 0, pending: 0 });
  });

  it("runs transfers with different connection keys concurrently", async () => {
    const queue = new DownloadQueue(2, 2, 6000);
    const first = deferred<Result<TransferOutcome, string>>();
    const second = deferred<Result<TransferOutcome, string>>();
    const started: string[] = [];

    const p1 = queue.queueTask(async () => {
      started.push("first");
      return first.promise;
    }, "first", false, "https://cdn.test/first.mp4");
    const p2 = queue.queueTask(async () => {
      started.push("second");
      return second.promise;
    }, "second", false, "https://cdn.test/second.mp4");

    await flush();
    expect(started).toEqual(["first", "second"]);

    first.resolve(outcome("first"));
    second.resolve(outcome("second"));
    await Promise.all([p1, p2]);
  });

  it("rejects a task promise when the task throws, and frees the slot", async () => {
    const queue = new DownloadQueue(1, 1, 0);
    const failing = queue.queueTask(async () => {
      throw new Error("boom");
    }, "bad", false);
    await expect(failing).rejects.toThrow("boom");
    await flush();
    await expect(queue.queueTask(async () => outcome("ok"), "next", false)).resolves.toEqual({
      tag: "Ok",
      value: { path: "ok" },
    });
  });

  it("cancels a queued task with an aborted-no-partial outcome", async () => {
    const queue = new DownloadQueue(1, 1, 0);
    const blocker = deferred<Result<TransferOutcome, string>>();
    const running = queue.queueTask(async () => blocker.promise, "first", false);
    const pending = queue.queueTask(async () => outcome("never"), "second", false);

    expect(queue.cancelPendingTask("second")).toBe(true);
    await expect(pending).resolves.toEqual({
      tag: "Ok",
      value: {
        download_id: "second",
        aborted_no_partial: true,
        ending_reason: {
          user_abort: true,
          e4XX_5XX_failure: false,
          percentage_incomplete: false,
          other_failure: false,
        },
      },
    });
    expect(queue.cancelPendingTask("second")).toBe(false);
    expect(queue.cancelPendingTask("first")).toBe(false);

    blocker.resolve(outcome("first"));
    await running;
  });

  it("throttles site-adapter tasks to their own capacity", async () => {
    const queue = new DownloadQueue(3, 1, 6000);
    const firstYt = deferred<Result<TransferOutcome, string>>();
    const secondYt = deferred<Result<TransferOutcome, string>>();
    const normal = deferred<Result<TransferOutcome, string>>();

    const started: string[] = [];
    const p1 = queue.queueTask(async () => {
      started.push("yt1");
      return firstYt.promise;
    }, "yt1", true);
    const p2 = queue.queueTask(async () => {
      started.push("yt2");
      return secondYt.promise;
    }, "yt2", true);
    const p3 = queue.queueTask(async () => {
      started.push("http");
      return normal.promise;
    }, "http", false);

    await flush();
    // The throttled task is skipped, the next non-throttled task runs instead.
    expect(started).toEqual(["yt1", "http"]);
    expect(queue.getStats()).toMatchObject({ running: 2, ytRunning: 1, pending: 1 });

    // Raising the throttled capacity releases the pending task.
    queue.setYoutubeCapacity(2);
    await flush();
    expect(started).toEqual(["yt1", "http", "yt2"]);

    firstYt.resolve(outcome("yt1"));
    secondYt.resolve(outcome("yt2"));
    normal.resolve(outcome("http"));
    await Promise.all([p1, p2, p3]);
    await flush();
    expect(queue.getStats()).toMatchObject({ running: 0, pending: 0 });
  });

  it("waits for the throttle delay before releasing a throttled task", async () => {
    vi.useFakeTimers();
    const queue = new DownloadQueue(1, 1, 6000);
    const firstYt = deferred<Result<TransferOutcome, string>>();
    const started: string[] = [];

    const p1 = queue.queueTask(async () => {
      started.push("yt1");
      return firstYt.promise;
    }, "yt1", true);
    const p2 = queue.queueTask(async () => {
      started.push("yt2");
      return outcome("yt2");
    }, "yt2", true);

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["yt1"]);

    firstYt.resolve(outcome("yt1"));
    await p1;
    // Immediately after settle the delay has not elapsed; a re-check is scheduled instead.
    expect(started).toEqual(["yt1"]);

    await vi.advanceTimersByTimeAsync(YOUTUBE_RECHECK_MS + 6000);
    await p2;
    expect(started).toEqual(["yt1", "yt2"]);
  });
});
