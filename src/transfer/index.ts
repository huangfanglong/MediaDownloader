/**
 * Transfer/assembly layer.
 *
 * Module map (rebuild):
 *  - `queue.ts`   — global download concurrency gate (service-side `In`, E09).
 *  - `retry.ts`   — attempt/backoff/timeout policy and the proven constants (E11-E14, E17).
 *  - `fetch.ts`   — one HTTP attempt, header sets and DNR session-rule model (E12, E28).
 *  - `assemble.ts`— HLS segment descriptors, init/AES boundary, concatenation, progress gates
 *                   (E15-E17, E19).
 *  - `remux.ts`   — container/codec decision table and remux boundary (E21, E24-E25).
 *  - `save.ts`    — filename, `chrome.downloads` request, terminal-state and error mapping
 *                   (E28, E29, E32).
 *
 * The layer is intentionally free of messaging and browser APIs: HTTP is an injected `FetchLike`,
 * decryption is an injected `Aes128Decrypter`, and saving is a plain data structure handed to the
 * extension shell.
 */
export * from "./queue.js";
export * from "./retry.js";
export * from "./fetch.js";
export * from "./assemble.js";
export * from "./remux.js";
export * from "./save.js";
