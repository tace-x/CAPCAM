# CapCam

CapCam is a local-first Chrome Extension project intended to make locally supplied image and video sources available in supported camera workflows in a later phase. All processing is planned to remain inside Chrome; this repository has no backend, cloud processing, analytics, authentication, native app, or database server.

## Current phase

**Phase 01 — Architecture & Foundation.** This phase establishes the MV3 extension, popup, service-worker/offscreen lifecycle, typed internal protocol, settings storage, and media/stream/site abstractions. It does **not** replace a camera or decode/play media.

## Development

```sh
npm install
npm run dev       # Vite UI development server (extension APIs require Chrome)
npm run build     # Chrome-loadable package in dist/
npm run test
npm run lint
npm run typecheck
```

Load the production extension from `dist/` at `chrome://extensions` with Developer mode enabled. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for details.

## Architecture overview

- **Popup (React):** requests typed runtime state and displays readiness.
- **Service worker (MV3):** coordinates lifecycle, validates messages, manages settings, and creates/recovers the offscreen document.
- **Offscreen document:** owns a small DOM-backed runtime boundary; it currently reports lifecycle status only.
- **Media layer:** defines metadata/source contracts and a metadata-only registry; no file bytes are kept in app state.
- **Stream layer:** defines stream lifecycle states/transitions; it does not create a media stream.
- **Storage:** central wrapper around `chrome.storage.local`, with validated settings and defaults.
- **Messaging/shared core:** versioned request/response/event envelopes, request IDs, validators, typed errors, and logging.
- **Content/site boundary:** a pure site-context abstraction is present, but no content script is registered or injected in Phase 01. No host permissions are requested.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Known limitations

- There is no media upload, decoder, playback, canvas rendering, `captureStream`, `getUserMedia` interception, WebRTC manipulation, or camera replacement.
- The content entry is intentionally not declared in the manifest; site access and site-specific logic are deferred until a later phase.
- The popup has status/refresh only; media controls and a dashboard are deferred.
- Offscreen status is a runtime foundation, not a media engine.
