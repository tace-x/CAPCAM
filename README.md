# CapCam

CapCam is a **local-first Manifest V3 Chrome extension** for loading user-selected image/video files and rendering them through a canvas-backed video `MediaStreamTrack`. Media processing stays on-device. There is no backend, cloud upload, authentication, analytics, or native application.

## Current phase

**Phase 06 — Camera Replacement Prototype (feasibility investigation, browser-gated)**, built on the Phase 05 offscreen runtime and Phases 02–04 media/playback/canvas pipeline. The production extension still stops at an offscreen-owned local stream; Phase 06 adds only controlled local test pages and a separately gated test build.

```text
Popup (client only)
  → service-worker coordinator (typed commands, document lifecycle, serializable state)
  → offscreen RuntimeManager
      → MediaEngine → PlaybackEngine → CanvasRenderer / StreamManager
      → HTMLCanvasElement.captureStream(fps) → MediaStream → video track
```

The offscreen document owns browser media APIs and active media resources. The service worker does not decode, play, render, or hold streams; it coordinates commands and lifecycle. The popup is independent of runtime ownership. Content scripts remain site-context-only. Messages and persisted settings never contain `HTMLVideoElement`, `HTMLImageElement`, `MediaStream`, tracks, canvas, `Blob`, or `File` objects.

## Runtime lifecycle

The offscreen `RuntimeManager` enforces the states `created`, `initializing`, `ready`, `active`, `stopping`, `stopped`, `resetting`, and `error` through an explicit transition table. Initialization is deterministic and cleans up partial initialization before entering `error`. Shutdown is idempotent and releases dependencies in reverse order; reset clears runtime-only media/playback/canvas/stream resources and does not touch persistent settings. A new runtime session ID is assigned after reset or document recreation.

The background `OffscreenManager` is the only production location that creates/closes the offscreen document. It correlates concurrent requests by unique request ID, validates typed protocol-v1 responses and session IDs, uses an 8-second default request timeout, reports `RUNTIME_REQUEST_TIMEOUT` distinctly, rejects stale-session requests, and performs bounded recovery for a lost message channel or stale runtime. A timeout alone is inconclusive and does not close the document. Runtime diagnostics and ping are lightweight, on-demand operations.

Playback and stream lifecycles remain separate: pausing, stopping, or ending video playback does not stop/recreate an active canvas stream. Source switching reuses the existing pipeline where possible. Browser-owned objects do not survive offscreen document destruction or extension reload; runtime media records/resources are intentionally memory-only.

**Phase 06 browser status: BLOCKED / not run.** The test pages distinguish native `getUserMedia()` from controlled `addTrack()`/`replaceTrack()` and include a camera-test-only offscreen → extension page → localhost transfer probe. The required Chrome run has not happened; no stream-transfer or WebRTC success is claimed and no target site has been modified.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build              # Normal Chrome-loadable package in dist/
npm run build:camera-test  # Separate test-mode package with offscreen stream probe
npm run dev                # Vite UI, developer harness, and local WebRTC pages
```

The visible `developer-test.html` harness exercises the shared playback and canvas pipeline in its own tab and previews that page's local stream; it is **not** a preview of the production offscreen stream. Phase 06's local test pages are under `tests/webrtc/`. `npm run build:camera-test` enables only the explicit boundary experiment; ordinary builds omit the test pages, exact test-page authorization, and offscreen BroadcastChannel listener. Automated tests use fakes/mocks for browser media and capture APIs. Chrome/Chromium was not available in the implementation environment, so manual Phase 06 acceptance remains **not run**.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PROTOCOL.md](docs/PROTOCOL.md), [docs/CAMERA_REPLACEMENT_RESEARCH.md](docs/CAMERA_REPLACEMENT_RESEARCH.md), and [docs/CAMERA_REPLACEMENT_RESULTS.md](docs/CAMERA_REPLACEMENT_RESULTS.md).

## Scope and permissions

The manifest requests only `storage` and `offscreen`; no host permissions, `<all_urls>`, `tabs`, or `scripting` permission is enabled. Local media limits, playback behavior, render presets, and codec caveats are documented in the guides.

Phase 06 authorization covers **only** local test pages and the explicit camera-test build. It does not implement a universal `getUserMedia()` override, arbitrary-site injection, site-specific production adapters, permission or identity bypass, anti-detection, external signaling, backend/cloud services, AI processing, a native application, or Chrome Web Store publishing. No production site is manipulated.
