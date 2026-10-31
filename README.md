# Media Downloader

An MV3 extension that watches page network traffic, recognises downloadable media, builds a
download plan, fetches and assembles the bytes, and saves the file. Progressive files and HLS
playlists can be downloaded. DASH manifests are detected and shown with quality information, but
DASH downloads are disabled until segment resolution is implemented. Tested on Brave Browser on
Windows.

  This was a half a day project built for fun entirely with DeepSeek-V4.1-Flash-1017 to test its capabilities. 
  Everything after around 1.0.3 releases were done by Kimi K3.1 & other open weight models as I test them all.

## Quick start

### Option 1
0. Clone this repository, then at repository's root:
```powershell
npm install
npm run verify     # typecheck + behaviour/parity/hardening tests + loadable-extension build
npm run build      # compile TS -> dist/extension + copy manifest/panel assets
```
1. Open browser's menu -> Extension -> Manage extensions. 
2. Enable 'Developer mode'
3. Click 'Load unpacked' & load `dist/extension` as an unpacked extension (Chromium 116+). The side panel lists media found on the active tab, **Download** assembles it and saves it through `chrome.downloads`.

### Option 2
0. Go to `Release` section and download the pre-built module instead then start with step 1 in `Option 1`.

## Layout

```
src/core/          shared types + Option/Result carriers
src/protocol/      channel ids, cyrb53, tagged wire serde, message catalogue
src/settings/      persistent settings model + hashed remote behaviour flags
src/discovery/     webRequest sniffing, classification tables, per-tab registry, tab metadata
src/manifests/     original minimal HLS and DASH parsers
src/plan/          strategy matrix + download-plan builder
src/transfer/      concurrency queue, retry/DNR, segment assembly, remux decision, save mapping
src/naming/        smart-naming rule compiler/selector/renderer + sanitiser
src/extension/     MV3 shell: browser gateways, worker client, service worker, scripts, panel
```

## License / acceptable use

Media Downloader is licensed under the **GNU General Public License v3.0 or later**
(`GPL-3.0-or-later`). See [LICENSE](LICENSE) for the full text.

The bundled ffmpeg.wasm core is a GPL-2.0-or-later FFmpeg build, its source and
third-party notices are described in [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).
The corresponding source for a release is available from this repository at the
released version tag.

Analyse and use only software you own or are authorised to examine.
This project does not intend to bypass DRM, licensing or paywalls.
