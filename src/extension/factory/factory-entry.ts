/**
 * Offscreen-document bootstrap: spawn the download worker.
 *
 * Why this is its own file: MV3's default extension-page CSP is `script-src 'self'`, which blocks
 * inline `<script>` blocks. The first build inlined this into factory.html, the worker was never
 * spawned, and every download died with "Timed out waiting for the worker to start".
 */
const workerUrl = chrome.runtime.getURL("/worker-entry.js");

try {
  const worker = new Worker(workerUrl, { type: "module" });
  worker.addEventListener("error", (event) => {
    console.error("[media-downloader] download worker failed", event.message ?? event);
  });
  console.info("[media-downloader] download worker spawned", workerUrl);
} catch (error) {
  console.error("[media-downloader] cannot spawn download worker", error);
}
