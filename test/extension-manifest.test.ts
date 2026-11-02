import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Manifest-level invariants. The page hook is injected by the browser (a MAIN-world content script
 * plus `chrome.scripting.executeScript({ files })` during healing), which reads files from the
 * extension package. Web-accessible resources are different: they are served to websites, so any
 * page that knows the extension id can fetch the file and detect the install.
 */
interface ManifestShape {
  content_scripts?: Array<{
    js?: string[];
    matches?: string[];
    run_at?: string;
    world?: string;
  }>;
  web_accessible_resources?: Array<{ resources?: string[]; matches?: string[] }>;
}

const manifest = JSON.parse(
  readFileSync(path.join(process.cwd(), "src/extension/manifest.json"), "utf8"),
) as ManifestShape;
const contentScripts = (manifest.content_scripts ?? []).flatMap((group) => group.js ?? []);

describe("extension manifest", () => {
  it("injects the page hook into the main world before page scripts run", () => {
    const group = (manifest.content_scripts ?? []).find((entry) => entry.js?.includes("page-hook.js"));
    expect(group?.world).toBe("MAIN");
    expect(group?.run_at).toBe("document_start");
    expect(group?.matches).toEqual(["<all_urls>"]);
  });

  it("keeps content scripts out of web-accessible resources", () => {
    const webAccessible = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
    for (const script of contentScripts) {
      expect(webAccessible).not.toContain(script);
    }
  });
});
