/**
 * Discovery subsystem public surface.
 *
 * `classify` = recovered constant tables and pure URL/MIME classification helpers;
 * `engine` = stateful chrome-free sniffing pipeline and per-tab registry;
 * `tab-metadata` = pure page title/thumbnail extraction used to fill `TabMeta`.
 */

export * from "./classify.js";
export * from "./engine.js";
export * from "./tab-metadata.js";
