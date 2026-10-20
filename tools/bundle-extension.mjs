/**
 * Build the loadable extension.
 *
 * Why bundling: Chrome extension packages cannot import files above the extension root, and
 * manifest-declared content scripts are classic scripts (no ESM imports). Emitting `tsc` output
 * per-file therefore produces exactly the failures we hit in the field:
 *   - "Service worker registration failed. Status code: 3" (imports escaped the package root)
 *   - "Cannot use import statement outside a module" (content script/page hook bundles)
 *
 * So every entry point is bundled into a self-contained file inside `dist/extension`, and the
 * static assets (manifest, HTML, icons) are copied next to it.
 */
import { mkdir, cp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const sharp = require("sharp");

const ROOT = path.resolve(process.argv[2] ?? ".");
const SRC = path.join(ROOT, "src");
const TOOLS = path.join(ROOT, "tools");
const OUT = path.join(ROOT, "dist", "extension");

const ENTRIES = [
  // Service worker: module, bundled so nothing escapes the package root.
  { entry: "extension/boot.ts", out: "boot.js", format: "esm" },
  // Content scripts are classic scripts in Chrome — force IIFE, no import/export statements.
  { entry: "extension/content-script.ts", out: "content-script.js", format: "iife" },
  { entry: "extension/page-hook.ts", out: "page-hook.js", format: "iife" },
  // Module worker hosted by the offscreen document.
  { entry: "extension/worker-entry.ts", out: "worker-entry.js", format: "esm" },
  // Offscreen document bootstrap. Must be an external file: extension-page CSP blocks inline.
  { entry: "extension/factory/factory-entry.ts", out: "factory/factory.js", format: "esm" },
  // Extension page script (panel.html uses <script type="module">).
  { entry: "extension/panel/panel.ts", out: "panel/panel.js", format: "esm" },
];

const STATIC_FILES = ["extension/manifest.json", "extension/panel/panel.html", "extension/factory/factory.html"];

await mkdir(OUT, { recursive: true });
await mkdir(path.join(OUT, "panel"), { recursive: true });
await mkdir(path.join(OUT, "factory"), { recursive: true });

for (const { entry, out, format } of ENTRIES) {
  await esbuild.build({
    entryPoints: [path.join(SRC, entry)],
    outfile: path.join(OUT, out),
    bundle: true,
    format,
    platform: "browser",
    target: ["chrome116"],
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`bundled ${entry} -> ${out} (${format})`);
}

for (const file of STATIC_FILES) {
  const target = path.join(OUT, file.replace(/^extension\//, ""));
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(SRC, file), target);
  console.log(`copied ${file.replace(/^extension\//, "")}`);
}

// ---------------------------------------------------------------------------
// ffmpeg.wasm (single-thread) vendored inside the package.
//
// The wrapper worker and core are loaded from chrome-extension:// URLs by a dedicated module
// worker; extension-page CSP therefore needs 'wasm-unsafe-eval'. GPLv3 notice: see
// docs/THIRD_PARTY.md.
// ---------------------------------------------------------------------------
const ffmpegWrapperDir = path.join(ROOT, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");
const ffmpegCoreDir = path.join(ROOT, "node_modules", "@ffmpeg", "core", "dist", "esm");
const ffmpegWrapperFiles = ["classes.js", "const.js", "errors.js", "index.js", "types.js", "utils.js", "worker.js"];
const ffmpegCoreFiles = ["ffmpeg-core.js", "ffmpeg-core.wasm"];
const ffmpegHashesPath = path.join(TOOLS, "ffmpeg-vendor-hashes.json");
const expectedHashes = JSON.parse(await readFile(ffmpegHashesPath, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(path.join(OUT, "vendor", "ffmpeg"), { recursive: true });
await mkdir(path.join(OUT, "vendor", "core"), { recursive: true });
try {
  for (const file of ffmpegWrapperFiles) {
    await cp(path.join(ffmpegWrapperDir, file), path.join(OUT, "vendor", "ffmpeg", file));
  }
  for (const file of ffmpegCoreFiles) {
    await cp(path.join(ffmpegCoreDir, file), path.join(OUT, "vendor", "core", file));
  }
  // Supply-chain guard: the vendored WASM runs under 'wasm-unsafe-eval'. Refuse to ship any
  // file whose SHA-256 differs from the reviewed manifest (update via a reviewed change).
  for (const [relative, expected] of Object.entries(expectedHashes)) {
    const actual = sha256(await readFile(path.join(OUT, "vendor", relative)));
    if (actual !== expected) {
      throw new Error(`ffmpeg vendor hash mismatch for ${relative}: expected ${expected}, got ${actual}`);
    }
  }
} catch (error) {
  throw new Error(`ffmpeg.wasm vendor files missing (run npm install): ${String(error)}`);
}
console.log("vendored ffmpeg.wasm (wrapper + single-thread core)");

// Action icons: rasterized from our own SVG (`src/assets/icon.svg`) at every manifest size.
// The toolbar badge is drawn by Chrome (red count pill); the artwork itself stays constant.
await rm(path.join(OUT, "bitmaps"), { recursive: true, force: true });
await mkdir(path.join(OUT, "bitmaps"), { recursive: true });
const iconSvg = await readFile(path.join(SRC, "assets", "icon.svg"));
for (const size of [16, 32, 48, 128]) {
  await sharp(iconSvg)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(OUT, "bitmaps", `icon-${size}.png`));
}


// Fail the build if a bundle still contains module syntax where Chrome forbids it.
const manifest = JSON.parse(await readFile(path.join(OUT, "manifest.json"), "utf8"));
const classic = manifest.content_scripts.flatMap((group) => group.js);
for (const file of classic) {
  const code = await readFile(path.join(OUT, file), "utf8");
  if (/^\s*(import|export)\s/mu.test(code)) {
    throw new Error(`classic content script still contains module syntax: ${file}`);
  }
}
console.log(`extension built at ${path.relative(ROOT, OUT)}`);
