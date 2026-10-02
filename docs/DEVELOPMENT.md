# Development Guide

## Prerequisites

- Node.js 20.19+ (or compatible current LTS) and npm.
- Google Chrome 116+ for the extension's offscreen-document API and manual media checks.

## Install and validate

```sh
npm install
npm run test
npm run typecheck
npm run lint
npm run build
```

`npm run dev` serves the popup shell for Vite UI iteration. Extension APIs and local file handoff are available only when the built extension is loaded in Chrome; when opened as an ordinary website, the popup reports a connection error. `npm run build` creates the package in `dist/` and copies the manifest/icons.

The Phase 02 tests use generated small PNG/WebM-signature fixtures, memory handoff stores, and fake decode elements where needed. They exercise protocol routing, lifecycle and cleanup logic, but do **not** substitute for running Chrome's real decoders or testing browser IndexedDB structured-cloning behavior.

## Load and exercise the extension

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this project's `dist/` directory.
5. Pin/open CapCam and choose local PNG/JPEG/WebP/GIF, MP4/WebM/Ogg video, or a browser-supported optional image candidate.
6. Confirm the popup lists MIME, source dimensions, aspect ratio as applicable, and video duration; remove an item and confirm it disappears.
7. Try a corrupt/mismatched input, unsupported type, and (if practical) a file larger than 512 MiB. Unsupported codecs/container features must report a structured failure rather than being inferred from the filename.

No media playback starts. The Phase 02 popup has no preview or thumbnail rendering.

## Debugging

- **Service worker:** open `chrome://extensions`, locate CapCam, and click its **service worker / Inspect views** link. Check `[CapCam][Runtime]`, `[CapCam][Protocol]`, and `[CapCam][Offscreen]` diagnostics.
- **Offscreen document:** use extension views or `chrome://inspect/#extensions` to inspect `public/offscreen.html`. Its DevTools console uses the `[CapCam][Media]` and `[CapCam][Offscreen]` prefixes. The service worker creates/recreates the document; explicit `offscreen.shutdown` releases runtime media and closes it.
- **Popup:** right-click and choose **Inspect**. Popup file selection creates a temporary extension-origin IndexedDB handoff; runtime messages carry only a transfer ID.
- **Settings storage:** inspect the extension's local storage through extension DevTools/Application tools. Settings remain under `capcam.settings.v1`; clearing extension storage restores Phase 01 defaults.
- **Temporary handoff:** the handoff object store is `capcam-media-transfer-v1` / `pending-files`. Entries are deleted when taken and have a 10-minute TTL; expiry sweeps occur when staging a new item and when the offscreen media engine initializes. It is not the persistent media registry.

## Build output and permissions

The manifest points at `background.js` and `popup.html`; Vite also emits the offscreen page and a future content entry. Use `dist/` as the unpacked root. The manifest requests only `storage` and `offscreen`; do not add host permissions, `<all_urls>`, `tabs`, or `scripting` without a narrowly justified later-phase requirement.

## Phase 02 limits

- The default per-file limit is 512 MiB (`CAPCAM_MAX_MEDIA_SIZE_BYTES`), enforced in popup and offscreen engine; engine construction can override it. No compression/transcoding/resizing occurs.
- The engine limits decoder work to three concurrent loads by default; queued and active loads are cancellable.
- Core image MIME types are PNG/JPEG/WebP/GIF; core video containers are MP4/WebM/Ogg. Optional image MIME types require signature matching and successful Chrome decoding. QuickTime/MOV is rejected by default because codec support is not universal.
- Chrome/Chromium is unavailable in some development environments. In that case report unit/build verification separately from browser verification; do not claim actual Chrome decoding or extension integration was exercised.
- Do not add camera interception, site logic, playback, canvas frame generation, `captureStream`, WebRTC manipulation, final MediaStream generation, cloud services, backend, or native application in Phase 02.
