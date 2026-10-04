# CapCam Phase 06.1 — Camera Replacement Capability Research

**Research date:** 2026-10-03
**Scope:** MV3 extension-only, local-first prototype on top of Phases 01–05.
**Status:** Documentation and code inspection complete; empirical browser investigation **not run** because Chrome/Chromium is unavailable in the workspace. No capability below is marked experimentally successful.

## Executive summary

CapCam's Phase 05 `MediaStream` is created and held by the **offscreen document**. The service worker coordinates serializable commands and state; popup/test pages use the typed runtime protocol. Chrome extension runtime messages are JSON-serialized, so that channel is not a path for a live `MediaStream` or `MediaStreamTrack`. A content script also cannot simply change page JavaScript by assigning a property in its isolated world.

The standard `RTCPeerConnection.addTrack()` and `RTCRtpSender.replaceTrack()` APIs are application-controlled operations: the page that owns/receives the track can explicitly add or replace a sender's same-kind track. They do not make a web page's native `getUserMedia({ video: true })` return a CapCam track.

A concrete test-only route has been implemented for Chrome measurement:

```text
Phase 05 offscreen stream
  → versioned same-extension-origin BroadcastChannel (test build only)
  → extension test page
  → window.postMessage with exact localhost target origin
  → normal localhost page-world consumer
  → explicit addTrack() / replaceTrack() in local RTCPeerConnection
```

Every arrow that carries the live stream is still **unverified in Chrome**. The controlled localhost path is intentionally not a production bridge or a universal camera replacement. No target video-chat site was examined or modified.

## Environment checked

- Workspace OS: `Linux 6.1.158+ x86_64` (`uname -srm`).
- Checked `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `chrome`, and `firefox` on `PATH`, plus `/usr/bin` and `/opt`; no browser executable was found.
- No Chrome version or browser permission prompt could be observed.
- The extension manifest retains `minimum_chrome_version: "116"` and only `storage`/`offscreen` permissions.
- This environment check is not a statement about Chrome availability on the user's own machine.

## Browser contexts and ownership

| Context | Documented capability/boundary | Phase 06 implication |
|---|---|---|
| MV3 service worker | No DOM; coordinates extension events and commands. | Cannot own the canvas/media element or hold CapCam's live stream. Keep runtime messages typed and serializable. |
| Offscreen document | Hidden extension document with DOM; `runtime` is the only Chrome extension API exposed there. Chrome lists `USER_MEDIA` and `WEB_RTC` as offscreen reasons for documents that use those capabilities. Offscreen `window.opener` is always `null`. | Existing canvas/stream remains offscreen-owned. No direct `opener` reference exists for `window.postMessage` to a page. The test bridge uses a normal Web API (`BroadcastChannel`) only in a special build. |
| Content script | Runs in an isolated JavaScript world. It can share/inspect DOM, but page JavaScript variables are not the same globals. Main-world execution is a distinct, page-visible operation. | A content-script-only shim is not evidence that the page's `getUserMedia()` changed. No content script or main-world injection was added. |
| Ordinary web page | Owns its own JS objects and must receive a track through a browser-supported mechanism before its app can use it. | The local consumer is a normal `http://localhost` page; its own `instanceof MediaStream`, video preview, and `RTCPeerConnection` callbacks are the evidence required. |
| Extension test page | Same extension origin as the offscreen document. | Can join the test-only BroadcastChannel. Its receipt is still not proof that an unrelated website can receive the stream. |

### Stream and message boundaries

1. `MediaRuntime`/`StreamManager` and `CanvasStreamPipeline` create and own the production stream/track in the offscreen context. The service worker does not receive that object. `stream.getTrackInfo` and stream state responses carry records only.
2. Chrome documents extension runtime messages as JSON-serialized. Do not send a `MediaStream`, `MediaStreamTrack`, canvas, video/image element, Blob/File, or frames through that path. JSON coercion or a mock response is not a media transfer.
3. `BroadcastChannel` and `window.postMessage` use the browser's structured-clone machinery, but that fact alone does not prove this exact `MediaStream` clone works in the target Chrome version or in each of the extension and web contexts. The Phase 06 test pages attempt the real transfer, check `instanceof MediaStream`, inspect the received track, and require successful visible playback.
4. The test-only route uses the same extension origin for the offscreen → extension-page hop. The second hop has an exact, validated localhost origin and a normal page context. Neither hop passes frame bytes through messages.
5. A structured-clone success between controlled contexts would not prove arbitrary-page integration. Origin boundaries, a target site's frame/embed policies, the absence of a direct window reference from the offscreen document, and the lack of a sanctioned site bridge still matter.

## API capability and compatibility notes

### `getUserMedia()` is a separate baseline

`navigator.mediaDevices.getUserMedia({ video: true })` is permission-gated and secure-context-dependent. In the baseline page, CapCam calls the native method after an explicit click and records the actual page-visible track. The test does not patch or override `getUserMedia`, fake a permission result, or claim that the browser-selected camera is CapCam.

A content script's isolated-world change would not establish what page-world JavaScript sees. The web consumer separately verifies the actual page's receipt of the generated stream before using it in WebRTC.

### `addTrack()` and `replaceTrack()` are controlled application paths

- `addTrack(track, stream)` can be called by a controlled page that already holds the track. The local loopback test negotiates two `RTCPeerConnection` objects without STUN/TURN or remote signaling and requires the receiving page's `ontrack` video to display.
- `replaceTrack(track)` replaces a sender track in an existing controlled call. The baseline is a native camera track; the page then explicitly supplies a generated track of the same kind. The sender identity/state and remote video are inspected. A resolved promise alone is not a full visual success criterion; browser constraint/renegotiation failures are recorded.
- Neither API changes `getUserMedia()` or forces an unrelated website to call either method.

### Chrome minimum-version finding and correction

The manifest supports Chrome 116. Chrome documents `chrome.runtime.getContexts()` (including the `OFFSCREEN_DOCUMENT` context filter) from Chrome 116, while `chrome.offscreen.hasDocument()` is documented only from Chrome 150. The existing coordinator had used the newer method. `src/background/offscreen-manager.ts` now checks `runtime.getContexts()` with the offscreen URL filter, preserving the stated minimum; `tests/background/offscreen-platform.test.ts` covers the query shape. This is source/type/unit-test evidence, **not** a Chrome 116 runtime test. `@types/chrome@0.0.287` predates `OFFSCREEN_DOCUMENT` in its `ContextType` union, so the documented string is narrowly cast with an explanatory comment.

The production offscreen document continues to use its existing `BLOBS` reason. The controlled camera and WebRTC calls occur in explicit test pages, not in the offscreen document; the camera-test bridge only requests an existing stream object.

## Implemented test artifacts

| Artifact | Purpose | Context/evidence required |
|---|---|---|
| `tests/webrtc/index.html` | Local test menu and scope notes. | No browser claim. |
| `tests/webrtc/basic-camera.html` | Native `getUserMedia({ video: true })` baseline. | Permission prompt, actual returned track, page-visible video. |
| `tests/webrtc/capcam-stream.html` | Reuses the existing canvas capture pipeline in a visible page. | Actual page-owned track; optional same-origin iframe `window.postMessage` clone probe and visible iframe receiver. |
| `tests/webrtc/loopback.html` | Controlled `addTrack()` consumer. | Remote `ontrack` event and displayed frame from a local peer pair. |
| `tests/webrtc/replace-track.html` | Native-camera baseline followed by controlled sender replacement with a page-owned generated track. | `replaceTrack()` result, sender identity/state, remote video. |
| `tests/webrtc/offscreen-bridge.html` | Uses `MediaIngestClient` and typed runtime commands to make/start the actual offscreen stream, then requests it through the isolated test bridge. | Extension page must receive/display the real offscreen track. Only the camera-test build activates the offscreen listener. |
| `tests/webrtc/web-consumer.html` + `tests/webrtc/camera-integration.ts` | Normal localhost page opened by the extension test page; the small integration abstraction is test-only. | Receives/plays the stream in page JavaScript; after a separate native camera permission request, it can explicitly `replaceTrack()` to CapCam, restore the original camera, test clones/enabled state, and run serialized toggles. It never patches `getUserMedia`. |
| `tests/webrtc/transfer-receiver.html` | Visible same-origin iframe target for the page-owned transfer probe. | Receiver must confirm a native MediaStream, track, and video playback. |
| `tests/webrtc/test.ts` | Shared test-page logic and explicit cleanup. | Browser artifact, not a Vitest simulation. |
| `src/shared/camera-test-bridge.ts` | Strictly versioned, test-only BroadcastChannel envelope. | Not a Chrome runtime protocol or a persisted record. |

`npm run build` omits the local Phase 06 test pages, the exact test-page sender authorization, and the offscreen bridge. `npm run build:camera-test` includes the eight controlled pages and deliberately enables the bridge for the measured extension-boundary experiment. The extension manifest adds no host permission, `tabs`, or `scripting` permission; the test consumer accepts only localhost hosts.

## Current evidence classification

| Claim | Evidence available now | Status |
|---|---|---|
| Content scripts and page JavaScript use distinct worlds. | Chrome documentation. | Documented; not a camera test. |
| Chrome runtime messaging is unsuitable for live media objects. | Chrome messaging documentation and the existing typed protocol boundary. | Documented/code-inspected; not an empirical stream test. |
| The offscreen document is hidden and exposes only the extension `runtime` API. | Chrome offscreen documentation. | Documented. |
| `runtime.getContexts()` fits the Chrome 116 minimum; `offscreen.hasDocument()` does not. | Chrome API documentation, source correction, and a unit test. | Documented plus unit-tested; not runtime-tested in Chrome 116. |
| Native `getUserMedia()` returns a user-authorized camera track in the page. | Harness is implemented. | **Unrun.** |
| A page-owned CapCam canvas stream can be cloned to a same-origin iframe. | Harness is implemented. | **Unrun.** |
| The actual offscreen `MediaStream` can cross BroadcastChannel into an extension page. | Test-only bridge and receiver are implemented. | **Unrun; explicitly unresolved.** |
| The actual offscreen stream can then cross to a localhost page via `window.postMessage`. | Controlled localhost receiver is implemented. | **Unrun; explicitly unresolved.** |
| The localhost page can add/replace that actual received track and display remote loopback. | Controlled WebRTC consumer is implemented. | **Unrun.** |
| An arbitrary video-chat site can be supplied with the stream. | No target-site work authorized or performed. | **Not claimed; deferred.** |

## Safety and scope boundaries

- No native virtual-camera driver, Swift/Xcode, backend/cloud service, remote signaling, or media server.
- No `getUserMedia()` interception, permission bypass, concealed synthetic media, anti-detection, identity/authenticity bypass, arbitrary-site injection, or production site adapter.
- No raw frames, base64, or serialized media objects through extension messages/settings/storage.
- Page-owned test streams and offscreen-owned Phase 05 streams are reported separately.
- Do not begin any further target-site investigation unless the controlled localhost path first succeeds; no unrelated production WebRTC implementation may be manipulated.

## Sources checked

- [Chrome content scripts: isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome extension messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Chrome offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) — offscreen lifecycle/permissions/reasons and `hasDocument()` Chrome 150 availability.
- [Chrome runtime API](https://developer.chrome.com/docs/extensions/reference/api/runtime) — `getContexts()` and context types.
- [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)
- [MDN `getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN `RTCRtpSender.replaceTrack()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack)
- [MDN `BroadcastChannel.postMessage()`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel/postMessage)
- [MDN `window.postMessage()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- [MDN structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)

**Next gate:** run the pages in actual Chrome 116+ and record each observed context, permission prompt, received track state/settings, iframe/page video playback, WebRTC connection result, cleanup, and error. Until that happens, keep all runtime-transfer claims marked unverified.
