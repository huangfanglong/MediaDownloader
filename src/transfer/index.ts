/**
 * Transfer/assembly layer.
 *
 * Module map (rebuild):
 *  - `queue.ts`   — global download concurrency gate.
 *  - `retry.ts`   — attempt/backoff/timeout policy and the proven constants.
 *  - `fetch.ts`   — one HTTP attempt, header sets and DNR session-rule model.
 *  - `limits.ts`  — in-memory body ceilings for what the worker will buffer (segments, tracks).
 *  - `assemble.ts`— HLS segment descriptors, init/AES boundary, concatenation, progress gates.
 *  - `remux.ts`   — staged-output MIME type.
 *  - `save.ts`    — filename, `chrome.downloads` request, terminal-state and error mapping.
 *
 * The layer is intentionally free of messaging and browser APIs: HTTP is an injected `FetchLike`,
 * decryption is an injected `Aes128Decrypter`, and saving is a plain data structure handed to the
 * extension shell.
 */
export * from "./queue.js";
export * from "./retry.js";
export * from "./fetch.js";
export * from "./limits.js";
export * from "./assemble.js";
export * from "./remux.js";
export * from "./save.js";
