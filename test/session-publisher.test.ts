/**
 * Publication policy: progress is cheap and rate-limited, structural changes are
 * durable before the caller returns, and concurrent writes never overlap.
 */
import { describe, expect, it } from "vitest";
import {
  PROGRESS_PERSIST_INTERVAL_MS,
  PROGRESS_UI_INTERVAL_MS,
  SessionPublisher,
} from "../src/extension/session-publisher.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("SessionPublisher", () => {
  it("throttles progress pushes and session checkpoints by wall clock", async () => {
    let now = 100_000;
    const ui: number[] = [];
    const writes: number[] = [];
    const publisher = new SessionPublisher({
      now: () => now,
      pushUi: () => ui.push(now),
      persist: async () => {
        writes.push(now);
      },
    });

    publisher.progress(); // first event: pushes and checkpoints
    now += 100;
    publisher.progress();
    publisher.progress(); // inside both windows
    now += 200;
    publisher.progress(); // pushes UI; persist window still closed
    now += PROGRESS_PERSIST_INTERVAL_MS;
    publisher.progress(); // pushes UI and checkpoints
    await flush();

    expect(ui).toEqual([100_000, 100_300, 102_300]);
    expect(writes).toEqual([100_000, 102_300]);
    expect(PROGRESS_UI_INTERVAL_MS).toBeLessThan(PROGRESS_PERSIST_INTERVAL_MS);
  });

  it("writes structural changes immediately and resolves after the write", async () => {
    let now = 7_000;
    const events: string[] = [];
    const publisher = new SessionPublisher({
      now: () => now,
      pushUi: () => events.push("ui"),
      persist: async () => {
        events.push("persist");
      },
    });

    await publisher.structural();
    expect(events).toEqual(["ui", "persist"]);

    // A structural write also restarts the UI and checkpoint windows for progress.
    now += 10;
    publisher.progress();
    await flush();
    expect(events).toEqual(["ui", "persist"]);

    now += PROGRESS_PERSIST_INTERVAL_MS;
    publisher.progress();
    await flush();
    expect(events).toEqual(["ui", "persist", "ui", "persist"]);
  });

  it("coalesces concurrent structural writes into one trailing write", async () => {
    const resolvers: Array<() => void> = [];
    let writes = 0;
    let active = 0;
    let maxConcurrent = 0;
    const publisher = new SessionPublisher({
      now: () => 1_000,
      pushUi: () => undefined,
      persist: () => {
        writes += 1;
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            active -= 1;
            resolve();
          });
        });
      },
    });

    const first = publisher.structural();
    const second = publisher.structural();
    expect(writes).toBe(1);

    resolvers.shift()?.();
    await flush();
    expect(writes).toBe(2);

    resolvers.shift()?.();
    await Promise.all([first, second]);
    expect(maxConcurrent).toBe(1);
    expect(writes).toBe(2);
    expect(resolvers).toHaveLength(0);
  });

  it("keeps the queue alive when a write fails", async () => {
    let attempts = 0;
    const publisher = new SessionPublisher({
      now: () => 1_000,
      pushUi: () => undefined,
      persist: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("storage unavailable");
      },
    });

    await expect(publisher.structural()).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    await expect(publisher.structural()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
