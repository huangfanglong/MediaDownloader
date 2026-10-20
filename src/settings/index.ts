/**
 * Settings module barrel: local persistent settings + remote behaviour flags.
 *
 * The two systems are deliberately separate (evidence E19-E23): local settings are user
 * preferences written through `mut-settings`; behaviour flags are remote per-host feature flags
 * fetched from `files.downloadhelper.net`. Re-exported together for the shell, but never merged.
 */

export * from "./flags.js";
export * from "./local.js";
