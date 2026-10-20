import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "src/extension/manifest.json"), "utf8")) as {
  name: string;
  short_name?: string;
  description?: string;
  icons?: Record<string, string>;
  action?: { default_title?: string; default_icon?: Record<string, string> };
  content_security_policy?: { extension_pages?: string };
};
const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const ICON_SIZES = ["16", "32", "48", "128"];

describe("Media Downloader branding", () => {
  it("uses the new name in the manifest, action title and package", () => {
    expect(manifest.name).toBe("Media Downloader");
    expect(manifest.short_name).toBe("Media Downloader");
    expect(manifest.action?.default_title).toBe("Media Downloader");
    expect(pkg.name).toBe("media-downloader");
    expect(manifest.description ?? "").toContain("Media Downloader");
  });

  it("declares icon and action-icon files at every manifest size", () => {
    for (const size of ICON_SIZES) {
      expect(manifest.icons?.[size]).toBe(`bitmaps/icon-${size}.png`);
      expect(manifest.action?.default_icon?.[size]).toBe(`bitmaps/icon-${size}.png`);
    }
  });

  it("hardens extension-page media resources and keeps the lockfile in sync", () => {
    const csp = manifest.content_security_policy?.extension_pages ?? "";
    expect(csp).toContain("img-src 'self' https: http:");
    expect(csp).toContain("media-src 'self' https: http:");
    const lock = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages[""]?.version).toBe(pkg.version);
  });

  it("keeps a reviewed hash manifest for the vendored ffmpeg binaries", () => {
    const hashes = JSON.parse(
      readFileSync(path.join(process.cwd(), "tools/ffmpeg-vendor-hashes.json"), "utf8"),
    ) as Record<string, string>;
    expect(Object.keys(hashes)).toHaveLength(9);
    expect(hashes["core/ffmpeg-core.wasm"]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps the editable SVG source and drops the old logo asset names", () => {
    expect(existsSync(path.join(process.cwd(), "src/assets/icon.svg"))).toBe(true);
    const manifestText = JSON.stringify(manifest);
    expect(manifestText).not.toMatch(/logo-128|harvester/i);
  });
});
