# Internal Protocol

## Version and envelope

Protocol version is **1** (`PROTOCOL_VERSION` in `src/shared/constants.ts`). Every command has a generated request ID and uses this shape:

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
  payload?: T;
}
```

All inbound commands are checked for protocol version, request ID, known command type, exact payload shape, supported values, and unexpected envelope fields. Responses are checked for envelope shape, matching request ID, and command-specific data shape. Failures are structured and never expose stack traces.

## Implemented commands

| Command | Payload | Response data | Purpose |
| --- | --- | --- | --- |
| `runtime.getStatus` | none | `CapCamState` | Initializes/reconciles the runtime and returns current state/settings. |
| `offscreen.initialize` | none | `OffscreenRuntimeInfo` | Creates/recreates and initializes the offscreen runtime. |
| `offscreen.getStatus` | none | `OffscreenRuntimeInfo` | Gets offscreen lifecycle status. |
| `offscreen.shutdown` | none | `OffscreenRuntimeInfo` | Shuts down runtime and closes the offscreen document. |
| `settings.get` | none | `CapCamSettings` | Loads validated settings/defaults. |
| `settings.update` | `Partial<CapCamSettings>` | `CapCamSettings` | Validates, persists, and returns the merged settings. |

Namespaces reserved for later phases include `media.*`, `playback.*`, `stream.*`, `site.*`, and `diagnostics.*`; unknown commands are rejected rather than accepted speculatively.

## Events

Typed event names currently defined for future internal use are `runtime.stateChanged`, `offscreen.statusChanged`, and `settings.changed`. The event envelope and validator exist; Phase 01 has no event subscription/broadcast path because the popup can query status and no live media state changes are implemented.

## Error codes

- `CAPCAM_RUNTIME_ERROR`
- `CAPCAM_MEDIA_ERROR`
- `CAPCAM_STREAM_ERROR`
- `CAPCAM_PERMISSION_ERROR`
- `CAPCAM_SITE_ERROR`
- `CAPCAM_STORAGE_ERROR`
- `CAPCAM_PROTOCOL_ERROR`

Every error has a stable `code`, a safe human-readable `message`, and optional non-sensitive metadata. Native exceptions are normalized before crossing a context boundary.

## Security

Only extension-originated messages are accepted by the service worker; offscreen commands must originate from the extension service worker. Page data is not bridged into the protocol. No external messaging, broad host permission, or content-script injection is enabled in Phase 01.
