/**
 * Dock-mode bootstrap: translate the persisted `dockmode` into the action/side-panel calls.
 *
 * Evidence: analysis/evidence/01-messaging-runtime.md E32 (§2.7); original service worker `$b`
 * (pretty 21224-21241; bytes ~504k) and `K0` (pretty 21216-21223). Two builds exist:
 *  - Chromium (`ht="google"`, `Ue`/`qe` flags, pretty 450-453): side panel API path;
 *  - Firefox (`qe === true`): `sidebarAction.toggle()` + `action.onClicked` path.
 * The planner is pure so the shell can execute the calls and tests can pin every branch.
 */

import type { DockMode } from "../protocol/messages.js";

/** Action popup page (proven: `setPopup({popup:"/content/popup.html"})`, pretty 21229/21239). */
export const POPUP_PAGE = "/content/popup.html";

export interface DockBootstrapInput {
  mode: DockMode;
  /** True on Chromium/Edge builds (proven `Ue = ht != "mozilla"`); false = Firefox path. */
  chromium: boolean;
  /** `typeof chrome.sidePanel !== "undefined"` (proven guard in `$b`). */
  hasSidePanel: boolean;
}

/**
 * A pure description of the calls to make at startup (or after a `redock`):
 *  - `setPopup`: `chrome.action.setPopup({popup})`; `null` clears a previously registered popup.
 *  - `actionClickTogglesSidebar`: (Firefox) `action.onClicked` toggles `sidebarAction`.
 *  - `sidePanelOptions` / `sidePanelBehavior`: (Chromium) `chrome.sidePanel.setOptions` /
 *    `setPanelBehavior`.
 */
export interface DockBootstrapPlan {
  setPopup?: string | null;
  actionClickTogglesSidebar?: boolean;
  sidePanelOptions?: { enabled: boolean };
  sidePanelBehavior?: { openPanelOnActionClick: boolean };
}

/**
 * Branch table (proven `$b`, pretty 21224-21241):
 *
 * | mode    | Firefox                         | Chromium + sidePanel                                   | Chromium without sidePanel |
 * |---------|---------------------------------|--------------------------------------------------------|----------------------------|
 * | popup   | setPopup(popup page)            | disable sidePanel, no action click, setPopup(popup)    | setPopup(popup)            |
 * | sidebar | action click toggles sidebar    | enable sidePanel, open on action click, setPopup("")   | setPopup(popup)            |
 * | window  | clear popup (legacy branch)     | no calls (legacy branch has no Chromium implementation)| setPopup(popup)            |
 */
export function resolveDockBootstrap({
  mode,
  chromium,
  hasSidePanel,
}: DockBootstrapInput): DockBootstrapPlan {
  if (!chromium) {
    // Firefox path: `$b` only manipulates action.onClicked + action popup.
    if (mode === "sidebar") {
      return { actionClickTogglesSidebar: true, setPopup: null };
    }
    if (mode === "popup") {
      return { actionClickTogglesSidebar: false, setPopup: POPUP_PAGE };
    }
    // Legacy "window" branch: remove the click handler and clear the popup.
    return { actionClickTogglesSidebar: false, setPopup: null };
  }

  if (hasSidePanel) {
    if (mode === "sidebar") {
      return {
        sidePanelOptions: { enabled: true },
        sidePanelBehavior: { openPanelOnActionClick: true },
        setPopup: "",
      };
    }
    if (mode === "popup") {
      return {
        sidePanelOptions: { enabled: false },
        sidePanelBehavior: { openPanelOnActionClick: false },
        setPopup: POPUP_PAGE,
      };
    }
    // "window" is not implemented in the Chromium branch of the shipped switch.
    return {};
  }

  // No sidePanel API: every mode falls back to the action popup.
  return { setPopup: POPUP_PAGE };
}

/**
 * Calls made after switching mode at runtime (`K0`, pretty 21216-21223): Chromium-only; popup
 * mode opens the popup for the current window, sidebar mode opens the side panel for it.
 */
export function resolveDockOpen(mode: DockMode): "openPopup" | "openSidePanel" | null {
  if (mode === "popup") return "openPopup";
  if (mode === "sidebar") return "openSidePanel";
  return null;
}
