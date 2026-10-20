/**
 * Service-worker entry point: real Chrome adapters + real fetch.
 *
 * Everything testable lives in `service-worker.ts` behind `BrowserGateway`; this file only wires
 * the browser in and starts the service.
 */
import { createChromeGateway } from "./chrome-gateway.js";
import { MediaDownloaderService } from "./service-worker.js";
import type { FetchLike } from "../transfer/fetch.js";

const fetchImpl: FetchLike = async (url, init) =>
  (await fetch(url, {
    ...(init?.headers !== undefined ? { headers: init.headers } : {}),
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
    ...(init?.cache !== undefined ? { cache: init.cache } : {}),
  })) as never;

const gateway = createChromeGateway();
console.info("[media-downloader] booting version", chrome.runtime.getManifest().version);
const service = new MediaDownloaderService({ gateway, fetchImpl });
void service.start();
