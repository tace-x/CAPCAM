# CapCam Architecture

## Phase boundary

This document describes the Phase 01 Manifest V3 foundation only. The extension is local-first and has no backend, database server, analytics, authentication, native application, or external media service. Camera replacement, media decoding, frame production, and site-specific behavior are explicitly out of scope.

## Component map

```text
Popup ──typed command──▶ Service Worker ──typed command──▶ Offscreen Document
                              │                                  │
                              ├── Storage                        └── Media Runtime (lifecycle only)
                              ├── Shared state                         │
                              ├── Media metadata registry               └── Stream layer (separate abstraction)
                              └── Content/site boundary (not injected in Phase 01)
```

### Popup

`src/popup` is a small React status surface. It sends `runtime.getStatus` through the shared messaging client and renders runtime/offscreen status. It owns presentation state only; it does not touch extension storage directly.

### Service worker

`src/background` is the central coordinator. `BackgroundRuntime` owns in-memory runtime status and composes the settings store with the offscreen manager. The service worker registers install/startup handlers, responds to validated commands, and is safe to restart: initialization is idempotent, and an existing offscreen document is discovered rather than blindly duplicated. It does not decode, render, or process media frames.

### Content script and site context

`src/content/site-context.ts` is a pure hostname-to-context abstraction with no site allowlist in this phase. `src/content/index.ts` is built as a future entry point but is deliberately not registered in `manifest.json`; there are no host permissions. Page data cannot directly invoke runtime commands. Future content commands must be narrowly scoped and still pass through the same validated protocol and sender policy.

### Offscreen document

`public/offscreen.html` hosts `src/offscreen`. `OffscreenRuntime` exposes initialize/status/shutdown lifecycle operations; `MediaRuntime` reports readiness only. The service worker controls document creation and closure using `chrome.offscreen`. If communication fails, the manager closes a stale document, recreates it, and retries once.

### Media layer

`src/media` defines metadata (`MediaMetadata`), a `MediaSource` contract, and a registry that stores source descriptors/metadata only. It does not store large file contents or implement image/video decoding.

### Stream layer

`src/stream` defines the lifecycle state machine (`IDLE` through `ERROR`) and a `StreamManager` facade for legal state transitions. No stream is produced in Phase 01.

### Storage

`src/storage` is the only application layer that accesses `chrome.storage.local`. It stores the small settings object under a versioned key, validates values, returns defaults when no record exists, and wraps browser failures in `CAPCAM_STORAGE_ERROR`.

### Messaging and shared core

`src/messaging` defines command/response/event types, unique request IDs, validation, and an extension runtime client. Phase 01 commands are limited to runtime status, offscreen lifecycle, and settings. `src/shared` holds status/state types, constants, typed errors, and privacy-conscious logging. Unknown or malformed messages return a structured protocol error and are not allowed to crash the service worker.

## Permissions and trust boundary

The manifest requests only `storage` and `offscreen`. No host permissions, `<all_urls>`, `tabs`, or `scripting` permission is present. Internal handlers require the sender to belong to this extension; the offscreen handler additionally accepts messages only from the service worker. External messaging is not enabled.

## Lifecycle and persistence

The service worker initializes on activation and on install/startup. Settings persist in `chrome.storage.local`; runtime/offscreen/stream state is intentionally ephemeral. If Chrome terminates the worker, its next event recreates the coordinator, reloads settings, checks for the offscreen document, and restores a ready state. Offscreen shutdown is explicit and followed by service-worker-controlled document closure.
