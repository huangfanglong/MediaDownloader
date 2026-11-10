/**
 * Service-worker entry point: real Chrome adapters + real fetch.
 *
 * Everything testable lives in `service-worker.ts` behind `BrowserGateway`; this file only wires
 * the browser in and starts the service.
 */
import { createChromeGateway } from "./chrome-gateway.js";
import { MediaDownloaderService } from "./service-worker.js";
import { fetchAdapter as fetchImpl } from "./fetch-adapter.js";

const gateway = createChromeGateway();
console.info("[media-downloader] booting version", chrome.runtime.getManifest().version);
const service = new MediaDownloaderService({ gateway, fetchImpl });
void service.start();
