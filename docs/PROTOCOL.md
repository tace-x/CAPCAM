# Internal Protocol

## Version and envelope

Protocol version is **1** (`PROTOCOL_VERSION`). Every command includes a unique request ID and a typed command name:

```ts
interface CommandEnvelope {
  protocol: 1;
  requestId: string;
  type: string;
  payload?: unknown;
}
```

Responses echo the request ID:

```ts
interface ResponseEnvelope<T = unknown> {
  protocol: 1;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code: string; message: string; metadata?: Record<string, unknown> };
}
```

Events have no request ID:

```ts
interface EventEnvelope<T = unknown> {
  protocol: 1;
  type: string;
  payload: T;
}
```

All inbound commands are validated for protocol version, request ID, known command type, exact payload shape, supported values, and unexpected fields. Responses are checked for their envelope, matching request ID, and command-specific payload. Events are checked against their discriminated event schema. Failures use structured, safe errors; native stack traces and file contents are not sent across contexts.

## Commands

| Command | Payload | Response data | Purpose |
| --- | --- | --- | --- |
| `runtime.getStatus` | none | `CapCamState` | Initializes/reconciles runtime and returns state/settings. |
| `offscreen.initialize` | none | `OffscreenRuntimeInfo` | Ensures offscreen media runtime is initialized. |
| `offscreen.getStatus` | none | `OffscreenRuntimeInfo` | Reads offscreen lifecycle status. |
| `offscreen.shutdown` | none | `OffscreenRuntimeInfo` | Releases media resources and closes the offscreen document. |
| `settings.get` | none | `CapCamSettings` | Loads validated settings/defaults. |
| `settings.update` | `Partial<CapCamSettings>` | `CapCamSettings` | Validates, persists, and returns merged settings. |
| `media.register` | `{ transferId: string }` | `MediaRecord` | Takes a short-lived local IndexedDB handoff and decodes its File in the offscreen document. The File/Blob is never in the message. |
| `media.get` | `{ mediaId: string }` | `MediaRecord` | Retrieves an active or inspectable failed record. |
| `media.list` | none | `MediaRecord[]` | Lists current runtime records. |
| `media.remove` | `{ mediaId: string }` | released `MediaRecord` | Cancels if loading; releases decoder resources and Blob URL; then removes the registry entry. |
| `media.clear` | none | `{ removed: number }` | Cancels active/queued loads and releases all records. |
| `media.inspect` | `{ mediaId: string }` | `MediaRecord` | Reads a record, including structured decode errors. |

`media.register` accepts exactly a validated `transferId`; arbitrary fields, media URLs, file bytes, and File/Blob values are rejected. The handoff ID points to a temporary extension-origin IndexedDB entry with a ten-minute TTL, not a persistent media library.

## Media record

`MediaRecord` is the one canonical runtime model. It contains `id`, `name`, `kind`, `mimeType`, `size`, nullable `width`, `height`, `aspectRatio`, and `duration`, active `sourceUrl` (null after release/failure), `createdAt`, lifecycle `status`, basic capabilities, and optional structured `error`. It never contains a File, Blob, image/video DOM element, or binary content. Registry records live only in the offscreen runtime and are not stored in `chrome.storage`.

Media IDs are unique `med_...` identifiers per registration. Transfer IDs are separate `transfer_...` identifiers and are consumed/deleted by the offscreen engine.

## Lifecycle events

| Event | Payload | Meaning |
| --- | --- | --- |
| `media.registered` | `{ mediaId, record }` | A format-identified runtime record is registered (`NEW`). |
| `media.loading` | `{ mediaId, record }` | Decoder/metadata work is active (`LOADING`). A queued item remains `VALIDATING` until a decoder slot is available. |
| `media.ready` | `{ mediaId, record }` | Decode/metadata succeeded (`READY`). |
| `media.failed` | `{ mediaId, record, error }` | Decode/resource stage failed; an `ERROR` record remains inspectable. |
| `media.released` | `{ mediaId, record }` | Resource cleanup completed and the record reached `RELEASED`. |
| `media.removed` | `{ mediaId }` | Released record was removed from the runtime registry. |

Early handoff, empty-file, size, and unsupported-signature failures may occur before a record exists; they return a structured command error rather than emitting `media.failed`.

The offscreen document emits validated envelopes to the service worker. The service worker relays only envelopes from this extension's exact offscreen document URL. UI clients accept broadcasts only from this extension's `background.js` and validate the event schema. An unsubscribe function removes the runtime listener.

## Media errors

Media command errors cross the generic protocol as `CAPCAM_MEDIA_ERROR`; `error.metadata.mediaCode` contains the specific stable `MEDIA_*` code. Failed records/events carry a `MediaErrorInfo` with that media code directly.

Implemented media codes:

- `MEDIA_UNSUPPORTED_TYPE`
- `MEDIA_DECODE_FAILED`
- `MEDIA_INVALID_FILE`
- `MEDIA_METADATA_FAILED`
- `MEDIA_TOO_LARGE`
- `MEDIA_LOAD_TIMEOUT`
- `MEDIA_RELEASED`
- `MEDIA_NOT_FOUND`
- `MEDIA_CANCELLED`
- `MEDIA_TRANSFER_FAILED`
- `MEDIA_INVALID_STATE`
- `MEDIA_RESOURCE_FAILED`

Other protocol errors use the `CAPCAM_*` error family. Error messages avoid exposing file bytes or stack traces.

## Settings and scope

Phase 01 settings remain routed through the storage abstraction with defaults: `enabled: false`, `fps: 30`, `width: 1280`, `height: 720`, `mirror: false`, `fitMode: "contain"`, and `loop: true`. Phase 02 does not change them or store media in `chrome.storage`.

No `playback.*`, camera interception, `getUserMedia` interception, WebRTC manipulation, `captureStream`, final MediaStream generation, or site-specific commands are implemented. Unknown commands remain rejected rather than accepted speculatively.

## Security and trust boundaries

The service worker accepts commands only from this extension's own extension pages; tab/content-script senders are not enabled. Offscreen commands are sent by the service worker and checked there. No external messaging, broad host permission, or content-script injection is enabled. Only local user-selected files are processed.
