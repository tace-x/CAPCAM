# Development Guide

## Prerequisites

- Node.js 20.19+ (or compatible current LTS) and npm.
- Google Chrome 116+ for the Manifest V3 offscreen document and manual media/playback/`captureStream()` checks.

## Install and validate

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run dev` starts Vite for UI iteration, the visible developer harness, and the controlled pages under `tests/webrtc/`. Open `developer-test.html` to exercise the shared playback/canvas pipeline in the current tab without extension APIs, or `tests/webrtc/index.html` for Phase 06 page-owned camera/WebRTC probes. `npm run build` creates the normal unpacked extension package in `dist/` and excludes the Phase 06 WebRTC test pages and offscreen stream bridge. `npm run build:camera-test` creates a separate test-mode package in the same `dist/` folder with those test pages and the narrowly gated bridge; it is required only for the actual offscreen→extension page→localhost stream-boundary experiment.

Vitest uses generated fixtures and fake media, canvas/capture, scheduler, and track objects. Coverage includes runtime transition legality; concurrent/idempotent initialize; partial-init cleanup; reverse-order shutdown; runtime-only reset and session rotation; operation gating; ordinary versus catastrophic failures; protocol validation, concurrent request IDs, timeouts, stale sessions and recreation; diagnostics/error serialization; media/playback/stream integration; and repeated cleanup. It does **not** execute Chrome's real media decoder, native `HTMLVideoElement.play()`, the Chrome offscreen API, or `HTMLCanvasElement.captureStream()`.

## Developer harness (visible local preview)

1. Run `npm run dev` and open `developer-test.html` from the Vite server, or open the built page from the unpacked extension.
2. Choose a local PNG/JPEG/WebP/GIF image or a short browser-supported MP4/WebM/Ogg video. The harness decodes it locally and loads its playback controller.
3. For an image, optionally enter a positive duration and press **Load source** to apply it. Without a duration the image is held at `currentTime: 0` until stopped/disposed; there is no image timeline. Try **Play**, **Pause**, **Stop**, **Restart**, **Loop**, **Speed**, and (for video) **Seek**. Confirm state and position update. Test a short non-looping video reaching `ENDED` and try loop/rate behavior.
4. Select a render preset, `cover`/`contain`, and optional horizontal mirror. Press **Create & start stream**. Confirm the local canvas updates, the harness `<video>` preview displays its captured output, stream state becomes `ACTIVE`, and track details appear. Use playback **Pause**, **Stop**, and video end; the canvas capture should not be disposed by playback. Try stream **Stop**, **Restart**, and **Dispose** independently.
5. Repeat with an image and video; try a portrait source to inspect crop/letterbox behavior.

This page owns and previews its own local media elements and capture stream. It is **not** a preview of the production offscreen stream. It sends no stream, canvas, frame, File, or media element through extension messaging.

## Phase 06 local WebRTC feasibility harness

### Page-owned, controlled tests

1. Run `npm run dev` and visit `http://localhost:5173/tests/webrtc/index.html` in Chrome 116+.
2. Start with **Native camera baseline**. Only after an explicit click, grant camera permission if desired. This page calls the browser's unmodified `getUserMedia({ audio: false, video: true })`; inspect the page-visible video and actual returned track settings.
3. In **CapCam-generated stream**, select a local image/video and create the stream. This reuses `CanvasStreamPipeline` in that visible page, then previews its actual local track. The optional same-origin iframe probe passes the live MediaStream through native `window.postMessage`; the iframe must confirm `instanceof MediaStream`, a live video track, and visible playback. It is a page-to-page probe, not an offscreen result.
4. In **Controlled WebRTC loopback**, select local media and start the local peer connection. Confirm the second peer's `ontrack` delivers and displays the generated track. No STUN/TURN server or external signaling is used.
5. In **Controlled sender replacement**, acquire a native camera track, start the local call using it, choose local media, create the generated canvas track, then click **Replace sender track**. Inspect the sender track ID/state and visually confirm remote output; `replaceTrack()` resolving alone is not enough to claim the full path passed. Restore the still-live camera track and stop the test when done.

These page-owned tests establish only browser behavior within the context that owns the generated stream. They do not establish an extension/offscreen-to-page transfer.

### Actual offscreen-to-local-page experiment (special test build)

1. Keep `npm run dev` running on its default `http://localhost:5173` origin; the localhost page is the controlled WebRTC consumer.
2. In a second terminal, run `npm run build:camera-test`. This replaces `dist/` with a test-mode extension package; load that `dist/` in `chrome://extensions` using **Load unpacked**. Do not use this test package as a normal product build.
3. Get the extension ID from `chrome://extensions` and open `chrome-extension://<extension-id>/tests/webrtc/offscreen-bridge.html`.
4. Click **Open local consumer tab**. The page checks that the consumer URL uses only `localhost`, `127.0.0.1`, or `::1`; confirm the real HTTP localhost page reports its explicit opener-origin handshake.
5. In the extension test page, choose an image/video and use **Ingest**, **Create**, and **Start**. Ingest goes through the existing Phase 02 temporary IndexedDB handoff and serializable typed commands. Confirm the offscreen stream state is `ACTIVE`.
6. Click **Request offscreen MediaStream**. The `camera-test` offscreen listener responds over the versioned same-extension-origin `BroadcastChannel`; the extension test page must display the received object/track. It then sends the stream with `window.postMessage()` using the exact localhost origin. In the separate localhost page, confirm the page itself receives a native `MediaStream`, displays its video track, and reports its own actual track settings.
7. In the localhost page, optionally request the native camera as a distinct baseline. Use **Add received CapCam track** to exercise `addTrack()` in that page's RTCPeerConnection, or start a native-camera call and explicitly use **Replace sender with CapCam track**. Confirm remote `ontrack` video, sender identity, and connection state. Repeat a stop/restart/transfer cycle and record failures as failures.
8. Close peer connections, stop local camera permission, stop/dispose the offscreen stream, and remove the source. Do not assume the browser track survives offscreen destruction or extension reload.

This route is an isolated feasibility experiment only. It does not inject code into the consumer page, override `getUserMedia`, request host permissions, or interact with any production video-chat site. The normal `npm run build` omits the offscreen BroadcastChannel listener; only `npm run build:camera-test` includes it. Since Chrome/Chromium is not installed in the current Linux workspace, all Phase 06 browser pages and the extension/page transfer above are **not run**; see the Phase 06 results document.

## Production extension acceptance

1. Run `npm run build`.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked** with this project's `dist/` directory.
3. Open CapCam and load a local supported image and short video. In the popup, test Playback controls and Canvas stream controls independently. The popup receives serializable records/track settings only.
4. While a short video is playing through an active production stream, let it reach `ENDED`. Confirm playback is `ENDED`, the stream remains `ACTIVE`, and the same track ID/readiness remains live. Use **Switch source** with another ready item and confirm the existing stream/track is reused when supported.
5. Remove active media and confirm playback listeners/timers and its stream are disposed before the Phase 02 resource is released. Exercise invalid/corrupt input, structured playback/stream errors, and a native play rejection if reproducible.
6. Use the popup DevTools console to exercise lifecycle operations through the public protocol (the popup is only the command client):

   ```js
   const sendCapCam = (type) => chrome.runtime.sendMessage({
     protocol: 1,
     requestId: `req_${crypto.randomUUID()}`,
     type,
   });
   await sendCapCam("runtime.getState");
   await sendCapCam("runtime.getDiagnostics");
   await sendCapCam("runtime.ping");
   ```

   Confirm state is one of the documented lower-case lifecycle values; diagnostics contain only counts, subsystem states, timestamps, session ID, and serialized error information. Check the session ID and persistent settings before/after `runtime.reset`; reset must rotate the session, dispose active runtime resources, reinitialize successfully, and leave settings unchanged. `runtime.shutdown` must release resources and close the offscreen document; `runtime.initialize` must create a new document/session. Run `runtime.getDiagnostics` again after each lifecycle operation.
7. Close/reopen the popup while an offscreen stream is active. The popup must not own or destroy the runtime. Suspend/restart the service worker from `chrome://extensions`, then reopen the popup and verify that the worker rediscovers/uses the offscreen document. Explicitly shut down/recreate the offscreen document and verify a **new** session with an empty runtime media registry; do not assume browser-owned tracks, media elements, or records survive document destruction or extension reload.
8. Confirm final cleanup stops all capture tracks, releases the canvas/render scheduler and playback listeners/timers, revokes media object URLs, and closes the offscreen document. Repeated initialize/shutdown/reset cycles must not accumulate tracks or loops.

Record Chrome version, fixture/container and codec, requested render configuration, playback/loop actions, lifecycle/session observations, actual track settings/identity, and any errors. The harness proves only its local pipeline; it does not prove production offscreen behavior.

### Critical acceptance gate

Do not mark Phase 05 browser-accepted until Chrome manually verifies the real production offscreen runtime and both the lifecycle and media path above. Do not mark Phase 06 browser evidence successful until the controlled local pages verify the actual received/displayed track and WebRTC consumer path. Automated fakes/builds are not a substitute. If Chrome is unavailable, record the gate as **not run**. No Chrome/Chromium executable exists in the current Linux workspace, so neither the Phase 05 production gate nor the Phase 06 browser experiment was run for this handoff; Phase 06 remains blocked pending a real Chrome run.

## Debugging

- **Service worker:** open `chrome://extensions`, locate CapCam, then click **service worker / Inspect views**. Check `[CapCam][Runtime]`, `[CapCam][Protocol]`, and `[CapCam][Offscreen]` diagnostics.
- **Offscreen document:** use extension views or `chrome://inspect/#extensions` to inspect `public/offscreen.html`. Its console uses `[CapCam][Media]`, `[CapCam][Playback]`, and `[CapCam][Stream]` prefixes. The centralized `OffscreenManager` creates/recreates the document; explicit shutdown releases playback, stream, and media resources before closing it.
- **Popup:** right-click and choose **Inspect**. The popup sends typed commands and consumes serializable responses/events. File selection stages a short-lived extension-origin IndexedDB transfer; runtime messages carry only a transfer ID.
- **Developer harness:** inspect the harness page's DevTools console. Its source elements, local captured stream, preview video, and canvas belong to that visible developer page.
- **Settings storage:** Phase 01 settings remain under `capcam.settings.v1`. Runtime reset does not change persistent settings; clearing extension storage restores defaults.
- **Temporary handoff:** the handoff object store is `capcam-media-transfer-v1` / `pending-files`. Entries are deleted when taken and have a 10-minute TTL; expiry sweeps occur when staging a new item and when the offscreen media engine initializes. It is not the persistent media registry.

## Build output and permissions

Vite emits the popup, visible `developer-test.html`, offscreen page, service worker, and content entry into `dist/`; use `dist/` as the unpacked Chrome root. Only `npm run build:camera-test` adds the `tests/webrtc/` pages and offscreen stream bridge for the controlled boundary probe. The standard `npm run build` excludes both the test pages and test-only bridge from the unpacked package. The manifest still requests only `storage` and `offscreen`; it does not request host permissions, `<all_urls>`, `tabs`, or `scripting`. No native software, backend, cloud, external signaling server, or new runtime dependency is required.

## Scope and browser support

- The default per-file limit is 512 MiB; the engine also limits concurrent decoder work. No compression, transcoding, or resizing occurs.
- Canvas output dimensions are limited to 3840×2160 and FPS 1–60. Browser/driver track settings can differ from the request or be unavailable; requested values are not silently rewritten.
- Video uses native browser decoding/playback; supported codecs/containers and offscreen playback depend on Chrome and platform. Do not claim universal codec/browser support.
- Playback rates are limited to `0.25`, `0.5`, `1`, `1.25`, `1.5`, and `2`. Images remain at time zero; optional image presentation duration is available in the developer harness.
- Browser media, canvas, stream, track, listener, timer, and object-URL resources are runtime-only. They do not persist across offscreen document destruction or extension reload.
- Phase 06 authorization covers only transparent local test pages and the separately gated `camera-test` build. Do not add a universal `getUserMedia` override, arbitrary-site injection, site-specific production adapter, permission/identity bypass, anti-detection, external signaling, backend/cloud services, analytics, AI processing, a native application, or Chrome Web Store release. Do not run a target-site experiment before the controlled localhost WebRTC path succeeds.
