import type { BrowserGateway } from "./gateways.js";

/** Restores page hooks and content bridges in tabs opened before an extension update. */
export class TabHealing {
  private started = false;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly gateway: BrowserGateway) {}

  async heal(force = false): Promise<void> {
    if (force) {
      await this.inFlight?.catch(() => undefined);
      this.started = true;
      this.inFlight = this.perform(true);
      return this.inFlight;
    }
    if (this.started) return;
    this.started = true;
    this.inFlight = this.perform(false);
    return this.inFlight;
  }

  private async perform(force: boolean): Promise<void> {
    const marker = "content_scripts_healed";
    if (!force) {
      try {
        const stored = (await this.gateway.storage.session.get(marker).catch(() => ({}))) as Record<string, unknown>;
        if (stored[marker] === true) return;
      } catch {
        // Session storage can be unavailable. Try the heal once anyway.
      }
    }
    let injected = 0;
    let skipped = 0;
    let tabs: Awaited<ReturnType<typeof this.gateway.tabs.query>> = [];
    try {
      tabs = await this.gateway.tabs.query({});
    } catch {
      return;
    }
    for (const tab of tabs) {
      if (tab.id === undefined || tab.url === undefined || !/^https?:\/\//u.test(tab.url)) continue;
      if (/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/u.test(tab.url)) {
        skipped += 1;
        continue;
      }
      try {
        if (force) {
          const healed = await (async () => {
            try {
              await this.gateway.scripting.executeInTab(
                tab.id,
                () => {
                  delete (globalThis as { __mediaDownloaderHookInstalled?: boolean }).__mediaDownloaderHookInstalled;
                },
                [],
                { world: "MAIN" },
              );
              await this.gateway.scripting.executeFilesInTab(tab.id, ["page-hook.js"], { world: "MAIN" });
              await this.gateway.scripting.executeInTab(
                tab.id,
                () => {
                  const scope = globalThis as {
                    __mediaDownloaderContentBridgeInstalled?: boolean;
                    __mediaDownloaderBridgePing?: () => boolean;
                  };
                  delete scope.__mediaDownloaderContentBridgeInstalled;
                  delete scope.__mediaDownloaderBridgePing;
                },
                [],
                { world: "ISOLATED" },
              );
              await this.gateway.scripting.executeFilesInTab(tab.id, ["content-script.js"]);
              return true;
            } catch {
              return false;
            }
          })();
          if (healed) injected += 2;
          else skipped += 1;
          continue;
        }
        const hookAlive = await this.gateway.scripting
          .executeInTab(
            tab.id,
            () => Boolean((globalThis as { __mediaDownloaderHookInstalled?: boolean }).__mediaDownloaderHookInstalled),
            [],
            { world: "MAIN" },
          )
          .catch(() => false);
        if (hookAlive !== true) {
          const hookInjected = await this.gateway.scripting
            .executeFilesInTab(tab.id, ["page-hook.js"], { world: "MAIN" })
            .then(() => true)
            .catch(() => false);
          if (hookInjected) injected += 1;
          else skipped += 1;
        }
        const bridgeAlive = await this.gateway.scripting
          .executeInTab(
            tab.id,
            () => {
              const scope = globalThis as { __mediaDownloaderBridgePing?: () => boolean };
              try {
                return scope.__mediaDownloaderBridgePing?.() === true;
              } catch {
                return false;
              }
            },
            [],
            { world: "ISOLATED" },
          )
          .catch(() => false);
        if (bridgeAlive !== true) {
          const bridgeInjected = await this.gateway.scripting
            .executeFilesInTab(tab.id, ["content-script.js"])
            .then(() => true)
            .catch(() => false);
          if (bridgeInjected) injected += 1;
          else skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }
    await this.gateway.storage.session.set({ [marker]: true }).catch(() => undefined);
    if (injected > 0) {
      console.info("[media-downloader] injected bridge into", injected, "pre-existing tab context(s)", force ? "(forced after install/update)" : "");
    }
    if (skipped > 0) {
      console.info("[media-downloader] skipped", skipped, "restricted or host-denied tab(s) during healing");
    }
  }
}
