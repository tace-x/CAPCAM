# CapCam Architecture

## Phase boundary

Phase 05 adds a central offscreen runtime lifecycle manager on top of Phase 02 media ingestion, Phase 03 canvas/MediaStream rendering, and Phase 04 playback. The decoded media elements, playback controller, production canvas, `MediaStream`, video track, renderer, and schedulers are owned by the **offscreen document**. The service worker coordinates typed commands and document lifecycle; popup-facing responses and events contain serializable records only. No media element, `Blob`/`File`, canvas, stream, track, or raw frame is transported through runtime messaging or stored in persistent settings/runtime records. A selected `File` is briefly staged in the existing Phase 02 temporary IndexedDB handoff and deleted when consumed.

Playback is not stream lifecycle. Video playback reaching `ENDED`, or being paused/stopped, does not stop/recreate the canvas stream. In particular, a non-looping video leaves its last decoded frame available to the renderer while the existing track remains live. Source changes are coordinated by the offscreen runtime and reuse the existing pipeline/stream where practical.

The Phase 05 production extension does not implement `getUserMedia()` interception, camera replacement, WebRTC/`RTCPeerConnection` manipulation, site-specific adapters, permission/identity bypass, anti-detection, broad host permissions, backend/cloud upload, analytics, AI processing, a native app, or Chrome Web Store release. Phase 06 adds only local controlled-test pages and a separately gated test build; it does not change production content-script behavior or add a site adapter.

## Component map

```text
Popup (React)
  │ typed media/playback/stream commands; serializable responses/events
  ▼
Service worker coordinator
  │ typed commands; never handles canvas/stream/frame/media-element objects
  ▼
Offscreen document
  ├── MediaEngine / MediaRegistry / image + video resource managers
  ├── PlaybackEngine / PlaybackController (native media-element controls)
  ├── MediaRuntime (coordinates playback source and stream source changes)
  ├── StreamManager / CanvasStreamPipeline
  ├── CanvasManager / CanvasRenderer / FrameScheduler
  └── HTMLCanvasElement.captureStream(fps) → MediaStream → video track

Decoded source path (all DOM handles stay offscreen):
  MediaEngine ready source → PlaybackController controls its native element
                       └── CanvasRenderer draws that same element to the canvas

Separate visible developer-test.html
  ├── locally selected File → object URL → local image/video element
  ├── shared PlaybackEngine and CanvasStreamPipeline instantiated in this tab
  └── local canvas capture → preview <video> (not the production stream)
```

The manifest continues to request only `storage` and `offscreen`. There are no host permissions, `<all_urls>`, `tabs`, `scripting`, or external messaging permissions.

## Popup

`src/popup` is a client of the background coordinator, not a runtime owner. It provides the local-media picker/list, playback controls, and canvas-stream controls. Playback controls load/play/pause/stop/restart a source, seek video, set loop/rate, unload playback, and display serializable state/position/duration. The popup supports rates `0.25`, `0.5`, `1`, `1.25`, `1.5`, and `2`. Stream controls create/start/stop/restart/switch/dispose a canvas pipeline and inspect serializable track settings. The popup does not create/close the offscreen document, receive or preview the production `MediaStream`, or hold browser media objects.

`developer-test.html` is a separate developer-only surface. It loads a user-selected file into page-owned media elements, instantiates the shared playback and pipeline classes, attaches that local stream to a visible `<video>`, and displays the canvas/track snapshot. It can configure an optional image presentation duration. This is a genuine local preview of the harness's own pipeline, **not a proxy or preview of the production offscreen stream**; it sends no media, frames, or streams through runtime messages.

## Service worker

`src/background` coordinates settings, typed commands, and offscreen-document lifecycle. `OffscreenManager` is the only component that calls `chrome.offscreen.createDocument()`/`closeDocument()`. It discovers a document after service-worker wake, queries runtime state on demand, correlates responses by request ID, attaches the current runtime session ID to subsystem commands, rejects mismatched responses, and uses bounded recovery for stale sessions or a lost message channel. Its default request timeout is 8 seconds; `RUNTIME_REQUEST_TIMEOUT` is not treated as proof of a crash and does not itself close the document. To honor the manifest minimum of Chrome 116, document discovery uses `chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [...] })`, which is available from Chrome 116. It deliberately does not call `chrome.offscreen.hasDocument()`, documented from Chrome 150. Media/playback/stream commands are forwarded to the offscreen router. The worker does not inspect file bytes, allocate object URLs, create media elements, render frames, hold a `MediaStream`, or generate UI preview data.

The background event relay forwards only valid protocol event envelopes whose sender ID is this extension ID and whose sender URL is exactly `public/offscreen.html`. UI event clients validate that events originate from `background.js`. In the normal build, command senders remain constrained to this extension's own extension pages without a tab sender. The camera-test build adds one narrow exception for the exact `tests/webrtc/offscreen-bridge.html` extension URL so that its existing typed commands can be used from a test tab; no other extension tab or web page is allowed.

## Runtime lifecycle manager

`src/offscreen/runtime-manager.ts` is the single owner of runtime lifecycle coordination. It wraps the existing `MediaRuntime` rather than duplicating media, playback, canvas, or stream resource managers. The explicit lower-case states are `created`, `initializing`, `ready`, `active`, `stopping`, `stopped`, `resetting`, and `error`; transitions are validated by `runtime-state.ts`. `active` reflects native playback or active rendering, and native lifecycle events schedule an on-demand state reconciliation without a polling heartbeat.

Initialization is shared/idempotent and deterministic: the media runtime initializes first, then the already composed playback, canvas-pipeline, and stream-manager roles are exposed as ready. Canvas/track resources are allocated lazily by existing subsystem commands. If initialization fails, `MediaRuntime.shutdown()` releases any partial resources before the manager enters `error`. Ordinary media, playback, and stream errors return structured command errors without discarding a usable runtime. Catastrophic runtime failures trigger bounded cleanup and enter `error`; recovery is by explicit reset or a single coordinator recovery path, not an endless restart loop.

Shutdown rejects new subsystem work, waits for in-flight operations to settle, and releases playback controllers, stream tracks/schedulers/canvas references, and media resources in reverse dependency order. Repeated shutdown is idempotent. Runtime-only reset performs the same cleanup and reinitializes with a fresh session ID; it does not clear or rewrite persistent settings. Diagnostics expose session/state timestamps, subsystem readiness, and active resource counts only—never browser objects or media contents. A document recreation gets a new runtime session; previous media records and browser-owned objects are not assumed to survive.

## Offscreen media ownership and coordination

`public/offscreen.html` hosts `src/offscreen`. `MediaRuntime` owns `MediaEngine`, `PlaybackEngine`, and `StreamManager`. Phase 02 continues to own temporary handoff consumption, bounded local decode, media resources, object URLs, and the in-memory registry. `MediaEngine.getRenderableSource(mediaId)` returns only an in-context handle to a ready image/video element; the handle is never serialized.

`MediaRuntime.loadPlayback()` loads the requested ready source. If a live stream pipeline is using another media ID, the runtime switches that existing pipeline after playback has switched. The `stream.switchSource` path uses the same coordination. `stream.create` loads the selected source for playback before creating the initial stream. These operations share the decoded Phase 02 resource; they do not create a second video element or a decoder.

Before media is removed, the runtime disposes matching playback listeners/timers and stream pipelines before Phase 02 releases decoder elements and object URLs. Runtime shutdown disposes all playback and stream references before the media engine. All resource records remain in memory and runtime messages only carry IDs and serializable state.

## Playback engine

`src/playback` contains the serializable record/types, errors/events, deterministic transition table, engine, and controller. The engine owns one current playback session and allocates a unique `playback_...` ID. `PlaybackController` holds an in-context reference to the existing Phase 02 source element; it never sends that reference to the popup or service worker.

Playback states are `IDLE`, `LOADING`, `READY`, `PLAYING`, `PAUSED`, `ENDED`, `STOPPED`, and `ERROR`. Controller operations are serialized by the engine. Video uses the existing native `HTMLVideoElement`; the controller does not construct a second video element or implement a decoder. It listens for native play/pause/time/metadata/rate/end/error events, explicitly disables native `video.loop` so loop/end transitions stay deterministic, and handles looping from the `ended` event. Native `timeupdate` state is retained in-process and `playback.timeupdate` publication is throttled to at most once per 500 ms. Browser `play()` rejection and source errors become structured playback errors.

A seek input must be finite; negative values clamp to zero and values beyond a known duration clamp to that duration. If video metadata is not ready, the target is retained and applied when metadata arrives; known duration is also refreshed on `loadedmetadata`. Playback rates are restricted to `0.25`, `0.5`, `1`, `1.25`, `1.5`, and `2`.

Images remain static with `currentTime: 0`; no fake video element or synthetic image timeline is created. An optional positive `imageDurationSeconds` sets a presentation timeout (maximum 24 hours); if omitted, the image remains presented until stopped or disposed. The timer is pause/resume/rate/loop aware, but does not change image position.

Playback owns play/pause/seek/loop/rate/position/duration/ended semantics. The renderer owns transforms/output resolution and draws whichever frame the source currently exposes. Stopping playback resets source position but does not stop the stream. Reaching `ENDED` preserves the final video frame and leaves the stream lifecycle untouched.

## Canvas and renderer

`src/canvas` contains:

- **CanvasManager:** creates and configures one stable `HTMLCanvasElement` in the offscreen document, owns its 2D context, clears/resizes it, and zeroes dimensions/releases its reference on disposal.
- **calculateRenderTransform:** reusable centered aspect-ratio math. `contain` scales the full source into the output bounds; `cover` crops the longer source dimension symmetrically. Invalid dimensions/configuration produce a typed stream error.
- **CanvasRenderer:** draws the decoded Phase 02 `HTMLImageElement`/`HTMLVideoElement` source. It waits for image decode/video current data, clears the frame to black, uses computed source/destination rectangles, applies optional horizontal mirror, and restores context transforms each draw.
- **FrameScheduler:** one drift-corrected timer loop per pipeline, bounded to 1–60 FPS. Repeated `start()` calls do not make duplicate loops; `stop()`/`dispose()` cancel the outstanding timer. Render errors stop the loop and become structured stream errors.

The stream default is 1280×720 at 30 FPS, `cover`, mirror off. Presets include 1280×720 and 1920×1080 at 30/60 FPS. Bounds are currently limited to 3840×2160 and 1–60 FPS; requested values are not silently rewritten. Browser/driver `MediaStreamTrack.getSettings()` remains the source of truth for actual output settings. Phase 01 `DEFAULT_SETTINGS.fitMode` stays `contain`; Phase 03 render config is separate and does not alter stored preferences.

## Stream pipeline and lifecycle

`CanvasStreamPipelineFactory` combines a ready source from the Phase 02 provider, `CanvasManager`, `CanvasRenderer`, `StreamFactory`, `TrackInspector`, and one `FrameScheduler`. `StreamFactory` uses `HTMLCanvasElement.captureStream(fps)` (not `OffscreenCanvas.captureStream()`) and verifies exactly one video track is present. Stream IDs are generated separately from media and playback IDs.

`StreamManager` owns at most one pipeline and exposes typed create/start/stop/restart/switch/dispose/state/track-inspection methods. Stream states remain `IDLE`, `INITIALIZING`, `READY`, `ACTIVE`, `STOPPING`, `STOPPED`, and `ERROR`. Restart recreates a stopped capture stream/track; source switching updates the renderer without allocating a new canvas, stream, track, or scheduler. **Stream start/stop/restart only control the rendering scheduler and capture track; they do not play or pause the source.** Playback and stream controls are deliberately independent.

Cleanup stops every capture track, cancels the scheduler, releases DOM references, and zeroes the canvas dimensions. Playback separately removes video listeners and image timers, pauses native video on dispose, and releases its source reference. Media removal performs playback and stream cleanup before releasing the Phase 02 resource. No browser resource is persisted in `chrome.storage`.

## Protocol and trust boundaries

`src/messaging` defines protocol-v1 runtime, media, stream, playback, and settings commands, serializable command responses, and lifecycle events. Runtime commands include `runtime.initialize`, `runtime.shutdown`, `runtime.reset`, `runtime.getState`, `runtime.getDiagnostics`, and `runtime.ping`; the older coarse `offscreen.*` status facade remains available. Media/playback/stream commands run only in the offscreen runtime. Playback commands include `playback.load`, `play`, `pause`, `stop`, `restart`, `seek`, `setLoop`, `setRate`, `getState`, and `dispose`. Playback events include loading/loaded, play/pause, seek/timeupdate, ended/loop/loopchange/ratechange, stop, error, and disposed.

Every command has a unique request ID. Service-worker-to-offscreen subsystem commands additionally carry the active runtime session ID; the offscreen router validates the session before dispatch, and the coordinator checks response IDs, schemas, and session metadata before returning. Requests have a bounded 8-second default timeout and structured serialized errors; `RUNTIME_REQUEST_TIMEOUT` is distinct from a detected runtime/session failure. Diagnostics and `runtime.ping` are on-demand checks, not a polling heartbeat.

`PlaybackRecord` contains only IDs, media kind, state, current time, nullable duration, approved rate, loop flag, timestamps, and optional serializable `PlaybackErrorInfo`. Typed playback errors cross command responses as generic `CAPCAM_PLAYBACK_ERROR` with the stable specific code in metadata; snapshots/events can include `PlaybackErrorInfo` directly. `StreamInfo` and `TrackInfo` similarly exclude raw browser objects. Protocol validators reject unknown command payload fields and non-serializable/nonconforming state shapes.

No image/video element, `RenderableMediaSource` handle, File/Blob, stream, track, canvas, or frame may be placed in a protocol payload or event. The offscreen document emits validated event envelopes to the service worker. The worker relays only envelopes from this extension's exact offscreen document URL; UI clients accept broadcasts only from this extension's `background.js` and validate the event schema.

## Media ingestion (Phase 02 foundation)

The popup stages a selected File in the extension-origin temporary IndexedDB handoff store and sends only a transfer ID. The offscreen media engine validates a small file-signature read, MIME/container, and size; decoder managers load image/video metadata without starting video playback. It records original dimensions/aspect ratio and releases Blob URLs/decoder resources on remove/shutdown. Failed media records remain inspectable; successful media records and decoder elements remain runtime-only. See the Phase 02 behavior section in the README and source modules for supported formats and bounds.

## Phase 06 controlled camera-replacement investigation

Phase 06 keeps the production architecture unchanged and adds local test artifacts under `tests/webrtc/`. `basic-camera.html` is a native `getUserMedia({ video: true })` baseline; `capcam-stream.html` exercises a page-owned CapCam canvas stream and a visible same-origin iframe `window.postMessage` probe; `loopback.html` uses `RTCPeerConnection.addTrack()`; and `replace-track.html` starts with native camera acquisition before calling `RTCRtpSender.replaceTrack()` in the controlled page. These paths are deliberately distinct: page-owned generated tracks are not evidence that an offscreen-owned track crossed into a page.

`npm run build:camera-test` enables one additional experiment in the offscreen script: a versioned `BroadcastChannel` endpoint that responds only when a test page requests the active stream. The test page uses the existing typed/versioned runtime protocol and temporary Phase 02 IndexedDB file handoff to create/start the actual offscreen stream; the `MediaStream` object itself never travels through `chrome.runtime` messages or storage. The extension test page then uses `window.postMessage()` with a fixed localhost origin to deliver the received object to `web-consumer.html`, a normal `http://localhost` page that can inspect/display its own received track and explicitly exercise `addTrack()` or `replaceTrack()`.

This broker, its exact test-page sender allowance, and the dedicated `tests/webrtc/` pages exist only in the explicitly built `camera-test` package; ordinary `npm run build` omits those pages and compiles out the authorization exception and offscreen bridge listener. It requests no host permissions, changes no content script, and refuses remote consumer hosts. It is a controlled feasibility route, not a universal camera replacement mechanism and not a production-site integration. The browser runtime experiment has not been run in this workspace because Chrome/Chromium verification is pending; see [CAMERA_REPLACEMENT_RESEARCH.md](CAMERA_REPLACEMENT_RESEARCH.md) and [CAMERA_REPLACEMENT_RESULTS.md](CAMERA_REPLACEMENT_RESULTS.md). No browser capability or `MediaStream` transfer has been marked successful.

## Phase 07 Camera Integration architecture

Phase 07 implements the controlled camera integration layer in `src/camera-integration/`:

```text
Controlled Target Context (e.g. localhost)
  ├── Explicit RTCPeerConnection registration (WebRtcPeerConnectionRegistry)
  ├── GenericWebRtcTargetAdapter (finds video sender, detects ambiguities, replaces/restores track)
  ├── ExactOriginTargetRegistry (exact-origin allowlist resolver, rejects arbitrary sites)
  ├── LocalStreamProvider (in-context CapCam stream handoff)
  ├── CameraIntegrationCore / CameraIntegration (lifecycle, diagnostics, revalidation, gated by Phase 06)
  └── LocalCameraIntegrationAgent (operational target agent API)
        │ serializable status updates / IDs only
        ▼
CameraIntegrationHandoff
  │ typed commands (camera.getStatus, camera.detect, camera.enable, camera.disable, camera.switchSource)
  ▼
Background Runtime & Popup UI
```

### Key architectural invariants:
1. **Target Registration is Explicit:** `WebRtcPeerConnectionRegistry` only manages peer connections explicitly registered by the target context. It never scans arbitrary pages, patches `getUserMedia`, or globally monkey-patches `RTCPeerConnection`.
2. **Ambiguity Rejection:** If multiple live video senders exist on registered peer connections, `GenericWebRtcTargetAdapter` explicitly rejects discovery with `AMBIGUOUS_VIDEO_SENDERS` rather than guessing.
3. **Strict Serialization Boundary:** No `MediaStream` or `MediaStreamTrack` is ever sent through `chrome.runtime` messaging. The handoff carries only serializable status, revisions, and media IDs.
4. **Phase 06 Gate Preserved:** `PHASE_06_VERIFIED = false` remains in effect. Production activation is gated until real Chrome browser verification is complete, while controlled target development and testing operate cleanly in test environments.

## Phase 08 Camera Integration Hardening & Runtime Handoff

Phase 08 hardens the camera integration and runtime handoff across lifecycle transitions, source changes, failure recovery, and extension context lifecycles:

### 1. Stateful Lifecycle Machine
Camera integration strictly follows a validated lifecycle:
- `IDLE` → `DETECTING` → `READY` / `TARGET_REGISTERED` / `SOURCE_READY` → `ACTIVE` → `RESTORING` → `READY` / `SOURCE_READY`
- Failure states are explicit: `ERROR`, `UNSUPPORTED`, `BLOCKED`, `BLOCKED_PHASE_06_VERIFICATION`.
- Duplicate activations, duplicate restorations, and activating without a valid source/target are prevented idempotently.

### 2. Strict Track Ownership Guarantees
- **Target Native Camera Track:** Owned by the target web page realm. CapCam holds only a non-owning reference for restoration and **never** calls `.stop()` on it.
- **Canvas Capture Track / Stream:** Owned by `CanvasStreamPipeline` in offscreen/test realm and stopped on pipeline disposal.
- **Decoded Media Elements:** Owned by `ImageResourceManager` / `VideoResourceManager` in `MediaEngine`.

### 3. Source Switching & Rollback
- Supports seamless transitions between all source types while active: `image -> video`, `video -> image`, `video -> video`, `image -> image`.
- If a new source fails replacement, the system rolls back to the previous valid active CapCam track without destroying the target sender or leaking resources.

### 4. Target Disappearance & Cleanup
- When a registered `RTCPeerConnection` closes, is unregistered, or the sender disappears, the integration immediately transitions to `BLOCKED` with `capcamActive = false`. The system never gets stuck in `ACTIVE`.
- On context destroy, cleanup restores original tracks on usable senders before clearing connection registries and media references.

## Validation and known limits

Vitest covers explicit runtime transition legality; initialization/shutdown/reset/failure recovery; in-flight operation gating; session rotation and stale-session recovery; concurrent request correlation; timeout and channel-failure behavior; diagnostics/error serialization; and an end-to-end managed playback→canvas→stream lifecycle with track/canvas cleanup. Existing Phase 02–04 tests cover ingestion, playback controls, rendering, stream transitions, failure cleanup, and the invariant that ended playback preserves an active stream. Tests use fakes/mocks and do not execute Chrome's real media decoder, offscreen document, or `HTMLCanvasElement.captureStream()`.

The developer harness can exercise local image/video playback → canvas → `captureStream()` → video-track preview in Chrome. The production offscreen stream is deliberately not previewed. The manual Chrome gate must verify both harness and production image/video behavior, runtime reset/shutdown/recreation, popup close/reopen, service-worker wake/restart, and that no old media/stream resource is claimed to survive document recreation. Chrome/Chromium was not available in this implementation environment, so browser acceptance was not run. Do not claim Chrome acceptance until the gate in [docs/DEVELOPMENT.md](DEVELOPMENT.md) passes.
