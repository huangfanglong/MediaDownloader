/**
 * Validate a built extension directory the way Chrome will load it.
 *
 * Catches the two field failures we hit:
 *  1. service worker / page imports that escape the extension package root
 *  2. classic content scripts containing ESM import/export syntax
 *  3. manifest entries pointing at files that do not exist
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] ?? ".");
const EXT = path.join(ROOT, "dist", "extension");
const problems = [];

const exists = async (relative) => {
  try {
    await stat(path.join(EXT, relative));
    return true;
  } catch {
    return false;
  }
};

const manifest = JSON.parse(await readFile(path.join(EXT, "manifest.json"), "utf8"));

const checkFile = async (relative, label) => {
  if (!(await exists(relative))) problems.push(`${label}: missing ${relative}`);
  return relative;
};

const serviceWorker = await checkFile(manifest.background?.service_worker, "background");
for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  await checkFile(file, `icon-${size}`);
}
for (const [size, file] of Object.entries(manifest.action?.default_icon ?? {})) {
  await checkFile(file, `action-icon-${size}`);
}
const pageScripts = [manifest.action?.default_popup, manifest.side_panel?.default_path].filter(Boolean);
for (const page of pageScripts) await checkFile(page, "page");
for (const group of manifest.content_scripts ?? []) {
  for (const script of group.js ?? []) await checkFile(script, "content_script");
}

// Every JS file in the package must be self-contained or import only within the package root.
const walk = async (dir) => {
  const { readdir } = await import("node:fs/promises");
  const entries = [];
  for (const entry of await readdir(path.join(EXT, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...(await walk(relative)));
    else if (entry.name.endsWith(".js")) entries.push(relative);
  }
  return entries;
};
const jsFiles = await walk(".");
const importPattern = /(?:^|\n)\s*(?:import\s+[^;]*?from\s*|import\s*)(["'])([^"']+)\1/gmu;
for (const file of jsFiles) {
  const code = await readFile(path.join(EXT, file), "utf8");
  for (const match of code.matchAll(importPattern)) {
    const specifier = match[2];
    if (!specifier.startsWith(".")) continue; // bare specifiers are inlined by the bundler
    const resolved = path.resolve(path.dirname(path.join(EXT, file)), specifier);
    const relativeToRoot = path.relative(EXT, resolved);
    if (relativeToRoot.startsWith("..")) {
      problems.push(`${file}: import escapes extension root -> ${specifier}`);
    } else if (!(await exists(relativeToRoot))) {
      problems.push(`${file}: unresolved import -> ${specifier}`);
    }
  }
}

// Extension pages cannot run inline scripts under the default MV3 CSP.
for (const page of [manifest.action?.default_popup, manifest.side_panel?.default_path, "factory/factory.html"]) {
  if (!page || !(await exists(page))) continue;
  const html = await readFile(path.join(EXT, page), "utf8");
  const withoutComments = html.replace(/<!--[\s\S]*?-->/gu, "");
  for (const match of withoutComments.matchAll(/<script(?![^>]*\bsrc=)[\s>]/gu)) {
    problems.push(page + ": inline <script> is blocked by the extension-page CSP");
  }
}

// The page-hook fallback injection requires the resource to be web-accessible.
const war = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
if (!war.includes("page-hook.js")) problems.push("manifest: page-hook.js is not web-accessible");

// Entry points must invoke their bootstrap (a bundle that only exports an install function is
// a silent no-op in the browser — this exact bug shipped once).
const bootstrapChecks = [
  { file: "content-script.js", call: /bootContentScript\(\);/, log: "content bridge active" },
  { file: "page-hook.js", call: /installPageHook\(\);/, log: "page hook active" },
  { file: "boot.js", log: "service worker constructed" },
];
for (const check of bootstrapChecks) {
  if (!(await exists(check.file))) continue;
  const code = await readFile(path.join(EXT, check.file), "utf8");
  if (!code.includes(check.log)) problems.push(check.file + ': missing bootstrap log "' + check.log + '"');
  if (check.call && !check.call.test(code)) problems.push(check.file + ": entry point never calls its installer");
}

// Classic scripts must not be modules.
const classic = (manifest.content_scripts ?? []).flatMap((group) => group.js ?? []);
for (const file of classic) {
  const code = await readFile(path.join(EXT, file), "utf8");
  if (/^\s*(import|export)\s/mu.test(code)) problems.push(`${file}: classic script contains module syntax`);
}

const workerScripts = ["worker-entry.js", "factory/factory.html", "factory/factory.js"];
const ffmpegFiles = [
  "vendor/ffmpeg/worker.js",
  "vendor/ffmpeg/index.js",
  "vendor/core/ffmpeg-core.js",
  "vendor/core/ffmpeg-core.wasm",
];
for (const file of ffmpegFiles) if (!(await exists(file))) problems.push(`missing ffmpeg vendor file ${file}`);
const extensionCsp = manifest.content_security_policy?.extension_pages ?? "";
if (!extensionCsp.includes("wasm-unsafe-eval")) {
  problems.push("manifest: extension_pages CSP lacks 'wasm-unsafe-eval' (ffmpeg.wasm will not start)");
}
for (const script of workerScripts) if (!(await exists(script))) problems.push(`missing ${script}`);

if (problems.length > 0) {
  console.error("extension validation FAILED:");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log(
  `extension validation passed (${jsFiles.length} JS files, service worker ${serviceWorker}, ${classic.length} classic scripts)`,
);
