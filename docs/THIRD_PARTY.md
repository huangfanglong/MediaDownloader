# Third-party components

| Component | Version | Licence | Why it is bundled |
|---|---|---|---|
| @ffmpeg/ffmpeg (wrapper) | 0.12.15 | MIT | API around the FFmpeg worker |
| @ffmpeg/core (single-thread wasm) | 0.12.10 | GPL-2.0-or-later (FFmpeg GPL build) | merge/remux/transcode/MP3 for 1080p+ YouTube outputs |

The GPL-2.0-or-later core is bundled unmodified in `dist/extension/vendor/core/`; its corresponding
source is the `@ffmpeg/core@0.12.10` npm package and the upstream FFmpeg sources it was built from
(https://github.com/ffmpegwasm/ffmpeg.wasm, https://ffmpeg.org). Rebuilds copy the files from
`node_modules` (`npm install` is required before `npm run build`) and never commit the binaries.

Measured browser limits of the single-thread build: 2 GiB wasm heap; ~1.66 GB peak browser working
set for a 271 MB output; 1080p videos merge comfortably, long 1440p/4K outputs can exceed the heap
and are rejected before merging. WebM is a stream copy (VP8/VP9/AV1 + Vorbis/Opus), so MP4/AVC
sources can only be converted to WebM for clips up to 3 minutes.
