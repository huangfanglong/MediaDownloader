/**
 * Media container extensions the transfer layer can name and save.
 *
 * One list for the name normaliser (`save.ts`), the byte sniffer (`sniff.ts`) and the plan
 * validator in the service worker. They used to keep three copies and disagreed: the validator
 * refused `flv`/`mov`/`m4v` even though the planner can emit them and the sniffer/saver recognise
 * them, so those downloads failed before the transfer started.
 */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "m4v",
  "mkv",
  "webm",
  "mov",
  "flv",
  "ts",
  "mp3",
  "m4a",
  "ogg",
  "opus",
  "wav",
  "m2ts",
]);

/** True when `extension` (with or without a leading dot, any case) names a saveable media file. */
export function isMediaOutputExtension(extension: string): boolean {
  return MEDIA_EXTENSIONS.has(extension.toLowerCase());
}
