# Internal Protocol

## Version and envelopes

Protocol version is **1** (`PROTOCOL_VERSION`). Every command includes a unique request ID and a typed command name:

```ts
interface CommandEnvelope {
  protocol: 1;
  requestId: string;
  type: string;
  /** Present on service-worker → offscreen subsystem/lifecycle requests. */
  runtimeSessionId?: string;
  payload?: unknown;
}

interface ResponseEnvelope<T = unknown> {
  protocol: 1;
  requestId: string;
  success: boolean;
  /** Current offscreen runtime session when the response was produced. */
  runtimeSessionId?: string;
  data?: T;
  error?: { code: string; message: string; metadata?: Record<string, unknown> };
}

interface EventEnvelope<T = unknown> {
  protocol: 1;
  type: string;
  payload: T;
}
```

Inbound commands are validated for protocol version, request ID, known command type, exact payload shape, supported values, optional runtime session ID, and unexpected fields. Responses are checked for the matching request ID, runtime session, and command-specific data schema. Events are checked against their discriminated schema. Failures use structured serialized errors; native stack traces and file contents are not sent across contexts. The coordinator uses an 8-second default bound (within the requested 5–10 second range) and reports timeout as `RUNTIME_REQUEST_TIMEOUT`. A timed-out request may still finish in the offscreen document; the timeout is inconclusive and does not itself trigger document destruction.

The service worker owns request correlation, not the media runtime. It creates/closes offscreen documents through one `OffscreenManager` and sends one independent `requestId` per call, so concurrent commands can return out of order without being mixed up. Subsystem commands require the current `runtimeSessionId`; the offscreen runtime rejects missing/stale sessions with `RUNTIME_SESSION_MISMATCH`. On a stale-session rejection, the coordinator queries the new runtime state and retries the rejected command at most once. Lost-message-channel recovery is also bounded to one recreation/retry and is distinct from the timeout path.

## Commands

| Command | Payload | Response data | Purpose |
| --- | --- | --- | --- |
| `runtime.getStatus` | none | `CapCamState` | Reconciles background/offscreen/stream status and settings. |
| `runtime.initialize` | none | `RuntimeStateSnapshot` | Initializes the offscreen runtime idempotently; returns its session and lifecycle state. |
| `runtime.shutdown` | none | `RuntimeStateSnapshot` | Waits for active subsystem work, releases runtime resources, then closes the offscreen document. |
| `runtime.reset` | none | `RuntimeStateSnapshot` | Clears/reinitializes runtime-only resources and rotates the session; persistent settings are untouched. |
| `runtime.getState` | none | `RuntimeStateSnapshot` | Reads lifecycle state, session, timestamps, and the last serialized error. |
| `runtime.getDiagnostics` | none | `RuntimeDiagnostics` | Returns on-demand counts and subsystem states without browser objects or media data. |
| `runtime.ping` | none | `RuntimePingResponse` | Lightweight on-demand liveness/session check; no polling heartbeat is used. |
| `offscreen.initialize` | none | `OffscreenRuntimeInfo` | Ensures the offscreen runtime is initialized. |
| `offscreen.getStatus` | none | `OffscreenRuntimeInfo` | Reads offscreen lifecycle status. |
| `offscreen.shutdown` | none | `OffscreenRuntimeInfo` | Disposes local playback, stream, and media resources and closes the offscreen document. |
| `settings.get` | none | `CapCamSettings` | Loads validated settings/defaults. |
| `settings.update` | `Partial<CapCamSettings>` | `CapCamSettings` | Validates, persists, and returns merged settings. |
| `media.register` | `{ transferId }` | `MediaRecord` | Takes a short-lived local IndexedDB handoff and decodes in the offscreen document. File/Blob is never in the message. |
| `media.get` | `{ mediaId }` | `MediaRecord` | Retrieves an active or inspectable failed record. |
| `media.list` | none | `MediaRecord[]` | Lists current runtime records. |
| `media.remove` | `{ mediaId }` | released `MediaRecord` | Disposes matching playback and stream references, then releases decoder resources/Blob URL and removes the record. |
| `media.clear` | none | `{ removed: number }` | Disposes playback and stream references, then clears/releases all media. |
| `media.inspect` | `{ mediaId }` | `MediaRecord` | Reads a record, including structured decode errors. |
| `playback.load` | `{ mediaId, imageDurationSeconds? }` | `PlaybackRecord` | Loads a ready source; optional positive image presentation duration is in seconds. Reusing the same source/options is idempotent. |
| `playback.play` | `{ playbackId }` | `PlaybackRecord` | Starts/resumes native video or presents an image; does not start/recreate the stream. |
| `playback.pause` | `{ playbackId }` | `PlaybackRecord` | Pauses video/image presentation without changing stream lifecycle. |
| `playback.stop` | `{ playbackId }` | `PlaybackRecord` | Stops playback and resets position to zero; does not stop the stream. |
| `playback.restart` | `{ playbackId }` | `PlaybackRecord` | Resets to the beginning and plays. |
| `playback.seek` | `{ playbackId, time }` | `PlaybackRecord` | Seeks video in seconds; finite values clamp to zero/duration, and pre-metadata seeks are applied when metadata arrives. Images stay at time zero. |
| `playback.setLoop` | `{ playbackId, enabled }` | `PlaybackRecord` | Enables/disables loop behavior independently of stream lifecycle. |
| `playback.setRate` | `{ playbackId, rate }` | `PlaybackRecord` | Sets one approved playback rate. |
| `playback.getState` | none | `PlaybackRecord \| null` | Reads the current serializable playback record. |
| `playback.dispose` | `{ playbackId }` | `null` | Pauses/releases the playback controller, timers, listeners, and source reference. |
| `stream.create` | `{ mediaId, config }` | `StreamInfo` | Loads the selected source for initial playback, then creates an offscreen canvas/capture stream/one video track. |
| `stream.getState` | none | `StreamInfo` | Reads the current serializable lifecycle/config/track snapshot. |
| `stream.start` | `{ streamId }` | `StreamInfo` | Starts the controlled render loop/capture lifecycle only; it does not play the source. |
| `stream.stop` | `{ streamId }` | `StreamInfo` | Stops the render loop and capture track only; it does not pause playback. |
| `stream.restart` | `{ streamId }` | `StreamInfo` | Recreates a stopped capture stream/track and resumes rendering; playback remains independent. |
| `stream.switchSource` | `{ streamId, mediaId }` | `StreamInfo` | Coordinates playback/source change and updates the existing pipeline source when possible. |
| `stream.getTrackInfo` | `{ streamId }` | `StreamTrackInfo` | Returns a serializable video-track snapshot. |
| `stream.dispose` | `{ streamId }` | `StreamInfo` | Stops/disposes the pipeline and releases canvas/resource references. |

### Runtime state and session gating

`RuntimeStateSnapshot` uses the lower-case lifecycle states `created`, `initializing`, `ready`, `active`, `stopping`, `stopped`, `resetting`, and `error`. Subsystem commands are accepted only in `ready` or `active`, and only when their `runtimeSessionId` matches the current offscreen session. `runtime.initialize`, state/diagnostics/ping queries, and the coarse offscreen initialize/status compatibility calls are session-discovery operations; other lifecycle commands and all media/playback/stream commands are session-bound. Invalid state, payload, protocol version, or session returns a structured error response.

A reset is runtime-only: it releases active playback, capture tracks, scheduler/canvas references, object URLs, and media resources before reinitializing, but does not access persistent settings. Shutdown is idempotent. A newly created offscreen document receives a new session; in-memory media records and browser-owned resources are not restored across document destruction or extension reload.

`stream.create` requires a valid `med_...` ID and exact `RenderConfig` with integer width 1–3840, height 1–2160, FPS 1–60, fit mode `cover`/`contain`, and boolean `mirror`. Presets are 1280×720 and 1920×1080 at 30/60 FPS. Stream IDs are unique `stream_...` identifiers. The service worker forwards commands and does not own or preview the `MediaStream`.

Playback IDs are unique `playback_...` identifiers. All playback and stream mutations target their current ID. When an active stream exists, a `playback.load` source change also updates its renderer source through the offscreen `MediaRuntime`; the stream/track is retained where practical.

## Playback data and behavior

`PlaybackRecord` is a serializable snapshot:

```ts
interface PlaybackRecord {
  playbackId: string;
  mediaId: string;
  kind: "image" | "video" | null;
  state: "IDLE" | "LOADING" | "READY" | "PLAYING" | "PAUSED" | "ENDED" | "STOPPED" | "ERROR";
  currentTime: number;
  duration: number | null;
  playbackRate: 0.25 | 0.5 | 1 | 1.25 | 1.5 | 2;
  loop: boolean;
  startedAt: number | null;
  updatedAt: number;
  error: PlaybackErrorInfo | null;
}
```

For video, `currentTime`/`duration` are seconds sourced from the decoded native `HTMLVideoElement`. Seek inputs must be finite; negative values clamp to zero and values beyond a known duration clamp to that duration. A pending seek is retained until metadata is available. Playback rates are restricted to `0.25`, `0.5`, `1`, `1.25`, `1.5`, or `2`.

For images, `currentTime` is always `0`; there is no synthetic timeline and seek is a no-op. An optional `imageDurationSeconds` gives the image a presentation timeout (finite, greater than zero, at most 24 hours); without one, it remains presented until stopped/disposed. The duration timer respects pause/resume, rate, and loop settings. The production popup uses the default indefinite presentation; the developer harness exposes the optional duration control.

Playback owns play/pause/seek/loop/rate/position/duration/ended behavior. The renderer draws the same in-context decoded element; the stream manager owns `MediaStream` and track lifecycle. Playback pause/stop/end never destroys or recreates the stream. A non-looping video's final frame remains available to the renderer after `ENDED`.

## Stream data

`RenderConfig` is a serializable value only:

```ts
interface RenderConfig {
  width: number;
  height: number;
  fps: number;
  fitMode: "cover" | "contain";
  mirror: boolean;
}
```

Phase 03 default is `{ width: 1280, height: 720, fps: 30, fitMode: "cover", mirror: false }`. `cover` symmetrically crops to fill the canvas; `contain` centers the full source and leaves black bars. This is distinct from Phase 01 stored settings, whose `DEFAULT_SETTINGS.fitMode` remains `contain`.

`StreamInfo` includes nullable `streamId` and `sourceMediaId`, stream `state`, nullable config/track/error, a `disposed` flag, and `changedAt`. `TrackInfo` contains only string/boolean/status/settings values (ID/label/kind/readiness/enabled/muted and nullable width/height/frameRate/aspectRatio). It excludes the `MediaStream`, `MediaStreamTrack`, canvas, frame data, device IDs, and raw browser objects. Track settings are observations from `MediaStreamTrack.getSettings()`; they can differ from requested values or remain unavailable.

No image/video element, `RenderableMediaSource` handle, File/Blob, stream, canvas, or frame may be placed in a protocol payload or event.

## Lifecycle events

Playback events use this serializable payload shape:

```ts
interface PlaybackEventPayload {
  playbackId: string;
  mediaId: string;
  timestamp: number;
  record: PlaybackRecord;
}
```

| Event | Meaning |
| --- | --- |
| `playback.loading`, `playback.loaded` | Source load begins/completes. |
| `playback.play`, `playback.pause`, `playback.stop` | Playback lifecycle transition. |
| `playback.seek`, `playback.timeupdate` | Position changed or throttled native time snapshot. |
| `playback.ended`, `playback.loop`, `playback.loopchange` | Source reached end or loop state/action changed. |
| `playback.ratechange` | Approved playback rate changed. |
| `playback.error` | Controller recorded a structured playback failure. |
| `playback.disposed` | Playback session resources were released. |
| `stream.stateChanged` | Serializable stream lifecycle/config/track/error snapshot. |

Existing Phase 02 events remain:

| Event | Payload | Meaning |
| --- | --- | --- |
| `media.registered` | `{ mediaId, record }` | Runtime record registered (`NEW`). |
| `media.loading` | `{ mediaId, record }` | Decoder/metadata work is active (`LOADING`). |
| `media.ready` | `{ mediaId, record }` | Decode/metadata succeeded (`READY`). |
| `media.failed` | `{ mediaId, record, error }` | Decode/resource stage failed; `ERROR` record remains inspectable. |
| `media.released` | `{ mediaId, record }` | Cleanup completed and record reached `RELEASED`. |
| `media.removed` | `{ mediaId }` | Released record was removed from the runtime registry. |

The offscreen document emits validated event envelopes to the service worker. The worker relays only envelopes from this extension's exact offscreen document URL. UI clients accept broadcasts only from this extension's `background.js` and validate the event schema.

## Errors

Runtime orchestration uses stable structured codes including `RUNTIME_REQUEST_TIMEOUT`, `RUNTIME_NOT_READY`, `RUNTIME_STOPPED`, `RUNTIME_RESETTING`, `RUNTIME_SESSION_MISMATCH`, `RUNTIME_INITIALIZATION_FAILED`, `RUNTIME_SHUTDOWN_FAILED`, and `RUNTIME_INVALID_TRANSITION`. `RUNTIME_REQUEST_TIMEOUT` identifies only that the coordinator's bounded wait elapsed; it does not assert that the offscreen document crashed. Runtime snapshots and diagnostics carry a bounded serialized `lastError` record with a code, short message, and primitive details only.

All playback failures use generic protocol code `CAPCAM_PLAYBACK_ERROR`; `error.metadata.playbackCode` contains a stable `PlaybackErrorCode`. Playback snapshots/events can include serializable `PlaybackErrorInfo` directly. Codes are:

- `PLAYBACK_MEDIA_NOT_FOUND`
- `PLAYBACK_LOAD_FAILED`
- `PLAYBACK_PLAY_FAILED`
- `PLAYBACK_SEEK_FAILED`
- `PLAYBACK_INVALID_TIME`
- `PLAYBACK_INVALID_RATE`
- `PLAYBACK_INVALID_STATE`
- `PLAYBACK_DISPOSED`
- `PLAYBACK_SOURCE_ENDED`
- `PLAYBACK_NOT_FOUND`

All stream failures use generic protocol code `CAPCAM_STREAM_ERROR`; `error.metadata.streamCode` contains a stable `StreamErrorCode`. Stream snapshots/events may additionally include serializable `StreamErrorInfo`. Media errors cross the generic protocol as `CAPCAM_MEDIA_ERROR`; `error.metadata.mediaCode` contains the specific stable `MEDIA_*` code. Failed media records/events carry `MediaErrorInfo` directly. Other failures use the existing `CAPCAM_*` family. Messages do not expose file bytes or native stack traces.

## Phase 01 settings, trust, and scope

Phase 01 settings remain routed through the existing storage abstraction with defaults including `fitMode: "contain"`; Phase 03 render config does not modify or silently migrate them.

The service worker accepts commands only from this extension's own extension pages; tab/content-script senders are not enabled. No external messaging or broad host permission is enabled. There is no production `getUserMedia()` interception, universal camera replacement, site adapter, permission/identity bypass, anti-detection, backend/cloud/analytics/AI service, native application, or Chrome Web Store release. Unknown commands and unsupported payloads remain rejected.

## Phase 06 camera-test bridge (not this runtime protocol)

The separately gated `npm run build:camera-test` experiment defines a distinct protocol-v1 `BroadcastChannel` contract in `src/shared/camera-test-bridge.ts`. Its only request is `get-active-stream` with a request ID; its response is either an error record or the live browser `MediaStream` object. It is **not** sent through `chrome.runtime`, `CommandRouter`, storage, settings, or the service-worker event relay. It is enabled only in the camera-test offscreen bundle; the normal `npm run build` omits the `tests/webrtc/` pages and compiles out both the listener and exact sender exception. The test page uses the existing typed protocol for serializable media/stream commands. In the special build, the background router permits only the exact `chrome-extension://<id>/tests/webrtc/offscreen-bridge.html` sender URL (including when opened as a tab). The media object itself is tested only through browser-native structured-clone APIs. This experimental path is local/controlled, unverified in Chrome, and not a production-site integration.
