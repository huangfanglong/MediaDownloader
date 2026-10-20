/**
 * Download-worker entry point (loaded as a module worker from the offscreen document).
 */
import { bootDownloadWorker } from "./download-worker.js";
import { WORKER_SERVICE_CHANNEL } from "../protocol/channels.js";
import { FfmpegRunner } from "../transfer/ffmpeg.js";

bootDownloadWorker(new BroadcastChannel(WORKER_SERVICE_CHANNEL), {
  ffmpeg: new FfmpegRunner(),
});
