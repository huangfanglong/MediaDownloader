import { describe, expect, it } from "vitest";
import {
  BADGE_TEXT_COLOR,
  DOWNLOAD_BADGE_BACKGROUND,
  MEDIA_BADGE_BACKGROUND,
  NOTIFICATION_BADGE_BACKGROUND,
  computeBadge,
  formatBadgeCount,
} from "../src/extension/badge.js";
import {
  POPUP_PAGE,
  resolveDockBootstrap,
  resolveDockOpen,
  type DockBootstrapPlan,
} from "../src/extension/dock.js";

/**
 * Extension feedback: badge priority/colours and the dock-mode branch table.
 * Evidence: analysis/evidence/01-messaging-runtime.md E29 (badge, `Ly` pretty 22466-22483),
 * E32 (dock, `$b` pretty 21224-21241 and `K0` 21216-21223).
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

describe("dock bootstrap branch table (E32)", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveDockBootstrap>[0];
    expected: DockBootstrapPlan;
  }> = [
    {
      name: "firefox + sidebar toggles the sidebar on action click",
      input: { mode: "sidebar", chromium: false, hasSidePanel: false },
      expected: { actionClickTogglesSidebar: true, setPopup: null },
    },
    {
      name: "firefox + popup registers the popup page",
      input: { mode: "popup", chromium: false, hasSidePanel: false },
      expected: { actionClickTogglesSidebar: false, setPopup: POPUP_PAGE },
    },
    {
      name: "firefox + window clears the popup (legacy branch)",
      input: { mode: "window", chromium: false, hasSidePanel: false },
      expected: { actionClickTogglesSidebar: false, setPopup: null },
    },
    {
      name: "chromium + sidepanel + sidebar enables the panel and opens on click",
      input: { mode: "sidebar", chromium: true, hasSidePanel: true },
      expected: {
        sidePanelOptions: { enabled: true },
        sidePanelBehavior: { openPanelOnActionClick: true },
        setPopup: "",
      },
    },
    {
      name: "chromium + sidepanel + popup disables the panel and registers the popup",
      input: { mode: "popup", chromium: true, hasSidePanel: true },
      expected: {
        sidePanelOptions: { enabled: false },
        sidePanelBehavior: { openPanelOnActionClick: false },
        setPopup: POPUP_PAGE,
      },
    },
    {
      name: "chromium + sidepanel + window is a no-op (no Chromium implementation)",
      input: { mode: "window", chromium: true, hasSidePanel: true },
      expected: {},
    },
    {
      name: "chromium without sidepanel falls back to the popup for sidebar",
      input: { mode: "sidebar", chromium: true, hasSidePanel: false },
      expected: { setPopup: POPUP_PAGE },
    },
    {
      name: "chromium without sidepanel falls back to the popup for popup",
      input: { mode: "popup", chromium: true, hasSidePanel: false },
      expected: { setPopup: POPUP_PAGE },
    },
    {
      name: "chromium without sidepanel falls back to the popup for window",
      input: { mode: "window", chromium: true, hasSidePanel: false },
      expected: { setPopup: POPUP_PAGE },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(resolveDockBootstrap(input)).toEqual(expected);
  });

  it("uses the shipped popup page path", () => {
    expect(POPUP_PAGE).toBe("/content/popup.html");
  });

  it("describes the runtime dock-open call (K0)", () => {
    expect(resolveDockOpen("popup")).toBe("openPopup");
    expect(resolveDockOpen("sidebar")).toBe("openSidePanel");
    expect(resolveDockOpen("window")).toBeNull();
  });
});
