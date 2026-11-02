import { describe, expect, it } from "vitest";
import {
  BADGE_TEXT_COLOR,
  DOWNLOAD_BADGE_BACKGROUND,
  MEDIA_BADGE_BACKGROUND,
  NOTIFICATION_BADGE_BACKGROUND,
  computeBadge,
  formatBadgeCount,
} from "../src/extension/badge.js";

/**
 * Extension feedback: badge priority/colours.
 * Evidence: analysis/evidence/01-messaging-runtime.md E29 (badge, `Ly` pretty 22466-22483).
 */

describe("badge", () => {
  it("pins the badge colour constants", () => {
    expect(NOTIFICATION_BADGE_BACKGROUND).toEqual([255, 0, 0, 190]);
    expect(MEDIA_BADGE_BACKGROUND).toBe("#dc2626");
    expect(DOWNLOAD_BADGE_BACKGROUND).toBe("#0284c7");
    expect(BADGE_TEXT_COLOR).toBe("white");
  });

  it("shows the notification count in red when any notification exists", () => {
    expect(computeBadge({ notificationCount: 3, downloadingCount: 2, mediaCount: 4 })).toEqual({
      text: "3",
      backgroundColor: [255, 0, 0, 190],
      textColor: "white",
    });
  });

  it("counts remote notifications too (caller sums session + remote maps)", () => {
    expect(computeBadge({ notificationCount: 1 + 4, downloadingCount: 0 }).text).toBe("5");
  });

  it("shows detected media as a red count badge", () => {
    expect(computeBadge({ notificationCount: 0, downloadingCount: 0, mediaCount: 2 })).toEqual({
      text: "2",
      backgroundColor: "#dc2626",
      textColor: "white",
    });
  });

  it("prefers the media count over an active-download count", () => {
    expect(computeBadge({ notificationCount: 0, downloadingCount: 3, mediaCount: 1 }).text).toBe("1");
    expect(
      computeBadge({ notificationCount: 0, downloadingCount: 3, mediaCount: 1 }).backgroundColor,
    ).toBe("#dc2626");
  });

  it("shows the download count in blue only when no media is detected", () => {
    expect(computeBadge({ notificationCount: 0, downloadingCount: 2, mediaCount: 0 })).toEqual({
      text: "2",
      backgroundColor: "#0284c7",
      textColor: "white",
    });
  });

  it("clears the badge when nothing is pending", () => {
    const badge = computeBadge({ notificationCount: 0, downloadingCount: 0, mediaCount: 0 });
    expect(badge).toEqual({ text: "" });
    expect(Object.keys(badge)).toEqual(["text"]);
  });

  it("collapses large counts to 99+ so Chrome does not truncate them", () => {
    expect(formatBadgeCount(1)).toBe("1");
    expect(formatBadgeCount(99)).toBe("99");
    expect(formatBadgeCount(100)).toBe("99+");
    expect(formatBadgeCount(0)).toBe("");
    expect(computeBadge({ notificationCount: 0, downloadingCount: 0, mediaCount: 123 }).text).toBe("99+");
  });

  it("clamps negative counts to zero", () => {
    expect(computeBadge({ notificationCount: -1, downloadingCount: -5, mediaCount: -2 })).toEqual({
      text: "",
    });
  });

  it("returns a copy of the notification colour array", () => {
    const first = computeBadge({ notificationCount: 1, downloadingCount: 0 });
    (first.backgroundColor as number[])[0] = 0;
    expect(NOTIFICATION_BADGE_BACKGROUND).toEqual([255, 0, 0, 190]);
    expect(computeBadge({ notificationCount: 1, downloadingCount: 0 }).backgroundColor).toEqual([
      255,
      0,
      0,
      190,
    ]);
  });
});
