# CapCam Architecture

## Phase boundary

Phase 02 adds local image/video ingestion and metadata extraction to the Manifest V3 foundation. All file access, decoding, and media resource management remain in the extension's offscreen document. There is no backend, database server, cloud processing/upload, analytics, authentication, native app, site injection, or camera replacement.

## Component map

```text
User-selected File
  │
  ▼
Popup ── temporary local IndexedDB handoff ──▶ Offscreen Runtime
  │             (10-minute TTL)                     │
  │ media.register { transferId }                   ├── MIME/signature validation
  ▼                                                 ├── ImageResourceManager / VideoResourceManager
Service Worker ── validated command ───────────────▶├── MediaRegistry (memory only)
  │                                                 └── ObjectUrlManager + MediaSource lifecycle
  └── trusted event relay ◀── event envelope ◀──────────────┘
        │
        └── validated event broadcast ──▶ Popup subscription
```

## Popup

`src/popup` provides a local file picker, minimal media status/metadata list, and removal action. `MediaIngestClient` checks the configured UI size ceiling, stages the selected File in the extension-origin temporary handoff store, sends only `{ transferId }` as the `media.register` payload, then deletes the handoff in a `finally` cleanup. It does not put File/Blob objects in messages or settings storage. `MessagingClient.subscribeEvents` accepts only validated event envelopes emitted by this extension's `background.js`.

## Service worker

`src/background` coordinates runtime lifecycle, settings, commands, and the offscreen document. `OffscreenManager` ensures the document exists and retries after a stale context; media operations are forwarded as typed commands. The worker does not inspect file bytes, allocate object URLs, create image/video elements, decode media, render UI, or hold UI state.

The background event relay forwards only valid protocol event envelopes whose sender ID is this extension ID and whose sender URL is exactly `public/offscreen.html`. Its own broadcasts originate from `background.js`; arbitrary extension pages and web pages cannot impersonate offscreen lifecycle events. Command senders are independently constrained to extension pages without a tab sender.

## Offscreen media runtime

`public/offscreen.html` hosts `src/offscreen`. `MediaRuntime` owns the `MediaEngine`; the engine owns the temporary handoff consumer, bounded load queue, resource managers, object URL manager, and `MediaRegistry`.

For each upload the engine:

1. Takes/deletes the temporary File handoff, validates file size, reads at most 64 bytes for signature detection, and compares the detected MIME/container with the declared MIME (when present).
2. Creates a unique `med_...` runtime ID and a canonical metadata record; the registry stores no File, Blob, or DOM element.
3. Enforces a default maximum of three concurrent decode/metadata loads. Waiting loads are cancellable; removal/shutdown aborts active and queued work.
4. Creates and tracks a local Blob URL, then delegates decoding to an `ImageResourceManager` or `VideoResourceManager`. Image loading uses `Image.decode()`; video loading waits for metadata without calling `play()`.
5. Records MIME, original dimensions, aspect ratio, and for video the media duration/capabilities. Audio-track capability is reported only when the browser exposes track metadata; `false` may mean that the API is unavailable, not that the file has no audio. It does not resize or transcode.
6. On failure, releases decode resources and revokes the URL while retaining a structured `ERROR` record for inspection. On remove, it transitions through `RELEASING` to `RELEASED`, emits lifecycle events, revokes the URL, and removes the registry entry. Shutdown clears active/registered media and revokes any remaining tracked URLs.

`MediaSource`/`ImageMediaSource`/`VideoMediaSource` provide the lifecycle abstraction and idempotent release operation. Resource managers own decoder element creation and detach/clear their elements during release.

## Canonical media record and registry

`src/media/media-types.ts` defines the single `MediaRecord` used by the registry, command protocol, events, and popup. It includes an ID, safe display name, kind/MIME, file size, nullable dimensions/aspect ratio/duration, source Blob URL while active, creation time, status, basic capabilities, and optional structured media error. There is no parallel media model in storage.

`MediaRegistry` is runtime-first and exposes `register`, `get`, `list`, `remove`, `clear`, `has`, and source attachment/detachment. Public record reads are defensive copies. It is intentionally in-memory; media resources do not survive offscreen document shutdown.

## Local temporary handoff

`IndexedDbMediaTransferStore` exists only to cross the popup → service-worker → offscreen boundaries without copying large binary payloads through `chrome.runtime` messaging. It stores a File under a random `transfer_...` ID in an extension-origin IndexedDB object store; it is not a persistent media library, server, or application database. `take()` atomically reads and deletes the entry, popup cleanup attempts deletion in a `finally` block, and entries expire after ten minutes. Expiry is swept when staging new data and when the media engine initializes. `chrome.storage` continues to hold only validated settings.

## Format and safety policy

The default size ceiling is `CAPCAM_MAX_MEDIA_SIZE_BYTES` (512 MiB) and can be overridden when constructing `MediaEngine`; no silent compression, upload, or resize occurs. Baseline image MIME types are `image/png`, `image/jpeg`, `image/webp`, and `image/gif`; baseline video containers are `video/mp4`, `video/webm`, and `video/ogg`. Signature validation—not extensions or filenames—determines the candidate type. Optional image types (for example AVIF/BMP) still need successful browser decoding. QuickTime/MOV containers are rejected by default because browser support is not universal. Actual decode support remains browser/codec-dependent.

## Media errors and events

Media failures use `MediaEngineError` and stable `MEDIA_*` codes, surfaced through the extension protocol as `CAPCAM_MEDIA_ERROR` with the media code in error metadata. Decode-stage failures remain inspectable in the registry; early validation/handoff failures return directly to the caller before a media record exists.

Lifecycle events are typed and validated: `media.registered`, `media.loading`, `media.ready`, `media.failed`, `media.released`, and `media.removed`. The offscreen document publishes them to the service worker, which validates sender identity and relays them to UI contexts. The popup subscription validates the sender and event schema before updating presentation state.

## Other layers

- **Stream layer:** Phase 01 state machine only; Phase 02 does not generate or expose a MediaStream.
- **Content/site boundary:** the pure site-context abstraction remains unregistered; no host permissions or content-script access are added.
- **Settings storage:** `src/storage` remains the only application layer using `chrome.storage.local`; Phase 01 defaults and validation remain unchanged.
- **Messaging:** versioned typed commands/responses/events, request IDs, exact payload validation, sender validation, and structured errors are extended with the `media.*` operations.

## Permissions and privacy

The MV3 manifest requests only `storage` and `offscreen`; there are no host permissions, `<all_urls>`, `tabs`, `scripting`, external messaging, or cloud connections. Local user-selected media is not automatically uploaded or logged. Media record logs are limited to non-content metadata such as ID, kind, and byte size.
