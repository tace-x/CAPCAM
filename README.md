# CapCam

CapCam is a **local-first Manifest V3 Chrome extension** for loading user-selected image and video files into a later camera-source workflow. Processing stays inside the browser: the project has no backend, database server, cloud processing/upload, authentication, analytics, or native application.

## Current phase

**Phase 02 — Media Engine.** The popup can select local images/videos; a temporary local handoff sends only a transfer ID through extension messaging; the offscreen runtime validates the file, confirms browser decoding, captures metadata, and manages the resource lifecycle. The service worker remains a coordinator and does not read/decode file bytes.

Phase 02 does **not** replace a camera, play media, generate frames, produce a `MediaStream`, use `Canvas.captureStream()`, intercept `getUserMedia`, manipulate WebRTC, or run site-specific logic.

## Development

```sh
npm install
npm run dev       # Vite UI development server (extension APIs require Chrome)
npm run test      # Vitest unit/integration-path tests
npm run typecheck
npm run lint
npm run build     # Chrome-loadable package in dist/
```

Load the production extension from `dist/` at `chrome://extensions` with Developer mode enabled. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Phase 02 media behavior

- Baseline image MIME types: PNG, JPEG, WebP, and GIF. AVIF/BMP and other optional candidates are accepted only when their bytes identify the format and Chrome's decoder confirms the image.
- Baseline video containers: MP4, WebM, and Ogg video. QuickTime/MOV is not enabled by default; filename extensions are not treated as proof of decode support.
- MIME declarations are checked against a small file-signature read. Empty, mismatched, corrupt, unsupported, and oversized inputs receive structured `MEDIA_*` errors.
- The default per-file safety cap is **512 MiB** (constructor-configurable and enforced by both popup and offscreen engine). There is no automatic compression or resize; source dimensions are preserved.
- At most **three** media decodes run concurrently by default. Queued and active loads can be cancelled.
- File bytes use a short-lived IndexedDB handoff on the extension origin (10-minute TTL). The popup sends only a transfer ID through runtime messaging. The offscreen runtime takes/deletes the staged File and keeps media records/resources in memory; it does not use `chrome.storage` as a media library.
- Metadata includes MIME, dimensions, aspect ratio, and video duration. Object URLs and decode elements are revoked/released on failure, removal, and runtime shutdown.

## Architecture

- **Popup (React):** local file picker, minimal metadata/status list, and removal action.
- **Service worker (MV3):** validates protocol and sender, coordinates settings and offscreen lifecycle, routes typed commands, and relays validated offscreen events. It does not decode/render media or own UI state.
- **Offscreen document:** owns `MediaEngine`, image/video resource managers, in-memory registry, temporary handoff consumer, and tracked object URLs.
- **Media layer:** one canonical `MediaRecord` model, MIME/signature validation, bounded decode concurrency, structured errors, lifecycle events, and deterministic cleanup.
- **Storage:** existing Phase 01 settings abstraction remains the only user-settings store. Media `File`/`Blob` and DOM resources are never put in `chrome.storage`.
- **Stream/site layers:** remain abstractions only; Phase 02 does not create a stream, inject content scripts, or request host permissions.

The manifest requests only `storage` and `offscreen`. It does not request `<all_urls>`, host access, `tabs`, or `scripting`.

## Known limitations

- Actual image/video decoding depends on the Chrome build and its codecs. Unit tests use generated/tiny fixtures and fake resource managers; they do not prove that a particular Chrome codec build decodes every file.
- Chrome/Chromium is not available in the current development environment, so real offscreen-document, IndexedDB File-clone, and extension-popup integration have not been browser-verified here.
- Media records and decoded resources are runtime-only. Closing/restarting the offscreen runtime releases them; only an in-flight temporary handoff may persist until taken or expired.
- No playback controls, thumbnail UI, resizing, transcoding, camera replacement, frame generation, stream output, content script, or site integration is included.
