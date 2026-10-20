const fs = require("node:fs");
const path = require("node:path");
const roots = ["src", "test", "tools", "docs", "analysis/evidence"];
const exts = new Set([".ts", ".mjs", ".json", ".html", ".md", ".js"]);
let stripped = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (exts.has(path.extname(entry.name))) {
      const buffer = fs.readFileSync(full);
      if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        fs.writeFileSync(full, buffer.subarray(3));
        stripped += 1;
      }
    }
  }
}
for (const root of roots) walk(root);
for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts"]) {
  if (fs.existsSync(file)) {
    const buffer = fs.readFileSync(file);
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      fs.writeFileSync(file, buffer.subarray(3));
      stripped += 1;
    }
  }
}
console.log("stripped BOM from", stripped, "files");
const manifests = JSON.parse(fs.readFileSync("src/extension/manifest.json", "utf8"));
console.log("manifest ok:", manifests.content_scripts.length, "content scripts, worker", manifests.background.service_worker);
