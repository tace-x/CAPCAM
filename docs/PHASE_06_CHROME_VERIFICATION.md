# Phase 06 — Real Chrome Verification Runbook & Evidence Checklist

- **Prepared:** 2026-10-04
- **Current result:** **NOT RUN — no Chrome/Chromium is available in this workspace.**
- **Phase 06:** **BLOCKED / UNVERIFIED**
- **Phase 07:** **BLOCKED**

This document prepares the real-browser run; it does not change the Phase 06 gate, establish a capability verdict, or authorize Phase 07. Individual checks below are acceptance criteria for a future run. Do not record them as passed until the named evidence has been captured from a real, headed Chrome/Chromium session.

## Scope and safety boundaries

The run tests CapCam's existing **test-build-only** path:

`local file → offscreen Media Engine/Playback → CanvasStreamPipeline → canvas capture → offscreen MediaStream → camera-test BroadcastChannel → extension test page → exact-origin window.postMessage → controlled localhost consumer`

The normal production build does not include the Phase 06 test pages or the offscreen BroadcastChannel listener. Use `npm run build:camera-test` only for this experiment. The `web-consumer.html` page is a normal localhost page, not a production site. Its WebRTC controls act only on its own explicitly created local peer connections.

The optional native-camera action is a user-approved baseline solely for testing a local `RTCRtpSender.replaceTrack()` and restoration. It does **not** make a virtual camera device, replace native `getUserMedia()`, or establish that another application will receive CapCam media. `src/config/capabilities.ts` must continue to report `cameraReplacement: false`. Do not add injection, host permissions, site adapters, permission bypasses, or camera overrides. Do not upload fixtures, frames, or logs to a service.

## Canonical end-to-end entry point

Use one deterministic Phase 06 route; do not combine component-page results into a substitute end-to-end pass:

1. Run `npm run build:camera-test`, then load the resulting `dist/` as an unpacked extension.
2. Start `npm run dev` at `http://localhost:5173`.
3. Open `chrome-extension://<extension-id>/tests/webrtc/offscreen-bridge.html` (the canonical extension page; linked from the test-bench landing page).
4. In that page, open the fixed consumer `http://localhost:5173/tests/webrtc/web-consumer.html`, ingest a local fixture, create the stream (which loads the offscreen PlaybackEngine), click **Play loaded source**, then start the offscreen track and click **Request offscreen MediaStream**.
5. Record the transfer, Stop → Restart → Request again lifecycle, then Dispose. Close the consumer tab to capture the disconnect event and download **Phase 06 path evidence JSON**. Capture the separate DevTools/offscreen-context evidence called out below as required.

The report starts with every check **UNVERIFIED** and is updated only by observations in this live browser page. Its aggregate `pathReportStatus` summarizes only this controlled route; it is not the Phase 06 gate verdict. It records separate verdicts for PlaybackEngine `PLAYING`, native `MediaStream` receipt, one live video track, correlated offscreen `BroadcastChannel` response, exact-origin page/consumer connection, `requestVideoFrameCallback` samples in both pages, stop/restart track lifecycle, and consumer/offscreen stream cleanup. A bounded diagnostic-event list records consumer-side `track-ended` events and page disconnect/pagehide state without treating a missing optional event as a successful observation. A `play()` resolution is not frame evidence. Missing API support or missing observations stay `UNVERIFIED`; external prerequisites such as a browser-blocked popup may be `BLOCKED`; a tested path that fails is `FAIL`. Do not edit a report verdict manually, and do not use Vitest/build results as browser evidence. Downloaded JSON is local run evidence, not a browser test runner or a Phase 06 gate change.

The canonical page observes the actual transferred stream/track and rendered-frame callbacks in the extension and localhost pages. It does not replace the separate DevTools checks for the original offscreen `captureStream()` return value, `OFFSCREEN_DOCUMENT` context count, renderer call, popup lifecycle, native-camera sender restoration, or video-motion behavior in the numbered procedure.

## Required Chrome/Chromium environment

### Browser and operating environment

- **Minimum:** Chrome 116. `manifest.json` declares `minimum_chrome_version: "116"`; the offscreen manager also depends on `chrome.runtime.getContexts()`/`OFFSCREEN_DOCUMENT`, available from Chrome 116.
- **Recommended:** current stable Google Chrome. Record the exact browser product, version, and channel. A Chromium build is acceptable only if it exposes the required MV3/offscreen APIs; record its exact build separately rather than treating it as equivalent to Chrome.
- A **headed desktop session** with a visible browser UI is required. Headless execution cannot provide the visible-preview, extension-popup, file-picker, permission-prompt, and evidence checks in this runbook.
- The browser must permit Developer mode and **Load unpacked** at `chrome://extensions`; no enterprise policy may block unpacked extensions, offscreen documents, the localhost test page, or the DevTools inspection needed for evidence.
- Required browser APIs: MV3 extension service worker, `chrome.offscreen`, `chrome.runtime.getContexts`, `BroadcastChannel`, `HTMLCanvasElement.captureStream()`, `MediaStream`, `window.postMessage`, `RTCPeerConnection`, and `RTCRtpSender.replaceTrack()`. Whether this Chrome build can structured-clone CapCam's actual `MediaStream` over `BroadcastChannel` is **under test**, not an assumed prerequisite or a pre-verified capability.
- Use a clean Chrome profile if practical. Do not use `--headless`, `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, or other flags that manufacture media or auto-grant camera permission. Close unrelated tabs that may be using the camera.

### Local development environment and fixtures

- Node.js **20.19+** (or compatible current LTS) and npm, with this repository and dependencies installed (`npm ci`).
- Port **5173** available for `npm run dev`. Keep the Vite server running at `http://localhost:5173`; localhost is the controlled consumer origin.
- At least one local, browser-decodable image and one short local video. Prefer a high-contrast test card labelled “IMAGE A” and a short, silent video with a visibly advancing frame counter labelled “VIDEO B”. Record each fixture's filename, MIME type, size, dimensions, video container/codec, duration, and SHA-256. Use the same fixtures for repeats. Avoid personal media.
- A physical/OS-provided camera and permission on `http://localhost:5173` are required **only** for Step 18's native-camera-to-local-sender replacement and restoration checks. The camera is optional for the offscreen transfer/preview checks. If it is absent or permission is declined, mark Step 18 **BLOCKED / UNVERIFIED**, not passed and not bypassed.
- No backend, cloud service, remote signaling, STUN/TURN server, native driver, or internet media source is needed. Network access may be needed to install npm dependencies if they are not cached; the browser experiment itself stays local.

## Automated preflight and browser-assisted probes

Run the automated checks before opening Chrome. The special build overwrites `dist/`, so build it **last** and load only that resulting `dist/` folder for the boundary experiment:

```sh
node --version                 # 20.19+
npm --version
npm ci
npm test -- --reporter=dot --silent=true
npm test -- --reporter=dot --silent=true tests/webrtc/local-consumer-protocol.test.ts
npm run typecheck
npm run lint
npm run build
test ! -e dist/tests/webrtc/offscreen-bridge.html
npm run build:camera-test
test -f dist/manifest.json
test -f dist/tests/webrtc/offscreen-bridge.html
test -f dist/tests/webrtc/web-consumer.html
grep -q '"minimum_chrome_version": "116"' dist/manifest.json
git diff --check
```

A successful build or test is **not** browser evidence. Keep the normal-build absence check and camera-test-build presence check: loading normal `dist/` will not run the actual offscreen bridge experiment.

Start the local pages in a separate terminal and leave the server running:

```sh
npm run dev
```

In the **service worker DevTools console**, after the extension test page has opened and initialized the offscreen runtime, inspect the offscreen context:

```js
await chrome.runtime.getContexts({
  contextTypes: ["OFFSCREEN_DOCUMENT"],
  documentUrls: [chrome.runtime.getURL("public/offscreen.html")],
});
```

Save the returned count and URL. Expected during an initialized run: exactly one CapCam offscreen context. After the explicit runtime shutdown subtest in Step 15: zero; after a fresh initialization: one new context/session.

Use this **browser-assisted** DevTools snippet in the extension test page (`#extension-preview`) or localhost consumer (`#offscreen-preview`, and later `#remote-preview`) to count frames actually presented by that preview. It reports only non-identifying video settings; it deliberately omits `deviceId` and `groupId`:

```js
async function capcamVideoEvidence(selector = "#offscreen-preview", sampleMs = 3000) {
  const video = document.querySelector(selector);
  if (!(video instanceof HTMLVideoElement)) throw new Error(`Missing video ${selector}`);
  const stream = video.srcObject;
  if (!(stream instanceof MediaStream)) throw new Error(`${selector} has no native MediaStream`);
  const track = stream.getVideoTracks()[0];
  if (track === undefined) throw new Error(`${selector} has no video track`);
  const settings = track.getSettings();
  let frameCount = 0;
  let firstMediaTime = null;
  let lastMediaTime = null;
  let callbackId = null;
  let finished = false;
  const startedAt = performance.now();
  await new Promise((resolve) => {
    const onFrame = (_now, metadata) => {
      if (finished) return;
      frameCount += 1;
      firstMediaTime ??= metadata.mediaTime;
      lastMediaTime = metadata.mediaTime;
      if (performance.now() - startedAt >= sampleMs) {
        finished = true;
        resolve();
      } else {
        callbackId = video.requestVideoFrameCallback(onFrame);
      }
    };
    callbackId = video.requestVideoFrameCallback(onFrame);
    window.setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve();
    }, sampleMs + 1000);
  });
  if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
  return {
    selector,
    videoReadyState: video.readyState,
    paused: video.paused,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    streamActive: stream.active,
    frameCount,
    firstMediaTime,
    lastMediaTime,
    track: {
      kind: track.kind,
      readyState: track.readyState,
      enabled: track.enabled,
      muted: track.muted,
      settings: {
        width: settings.width ?? null,
        height: settings.height ?? null,
        frameRate: settings.frameRate ?? null,
        aspectRatio: settings.aspectRatio ?? null,
      },
    },
  };
}
await capcamVideoEvidence("#offscreen-preview", 3000);
```

Run the snippet separately for each preview and save the returned objects in the evidence folder. For an animated video, require more than one observed frame and advancing `mediaTime`; a static image may not advance media time. A visible frame counter in VIDEO B is an additional independent check. These snippets observe a real browser page; they do not create or fake media.

There is no unattended Chrome/WebDriver test runner in this procedure. File selection, popup actions, visible-frame inspection, and any camera permission prompt remain user-driven. The terminal checks and DevTools probes assist the real run, but only the headed-browser observations count for Phase 06 evidence.

## Run metadata and evidence handling

Create a local run folder, for example `artifacts/phase06/2026-10-04-chrome-<version>/`, and fill in:

```text
Run ID / operator:
Date and local timezone:
Browser product / channel / full version:
OS / version / architecture:
GPU / driver (if available):
Repository revision (and note whether worktree is dirty):
Loaded extension version / ID (ID may be redacted in shared evidence):
Loaded package: dist built by npm run build:camera-test
Local Vite origin / port:
Image fixture: filename, MIME, bytes, dimensions, SHA-256:
Video fixture: filename, MIME, bytes, dimensions, duration, container/codec, SHA-256:
Native camera available: yes/no; permission requested/granted/denied/not requested:
```

Save `chrome://extensions` and relevant page screenshots, sanitized page logs, service-worker/offscreen console output, stream/track snapshots, and frame-probe results. Redact device IDs, device/group identifiers, private filenames, and unrelated tabs. Do not save or share raw camera frames or personal media. For every numbered row below, record one of `PASS`, `FAIL`, `BLOCKED`, or `UNVERIFIED` and a relative evidence filename. Missing or ambiguous evidence is **UNVERIFIED**, never PASS.

## Manual Phase 06 procedure — 19 checks

Recommended execution order is **1–14, 16–19, then 15** so that the active stream remains available for popup, source-switch, sender, and reload tests before final cleanup. Step numbers preserve the requested coverage. If a run is interrupted, record the affected rows as NOT RUN and start a new run ID after rebuilding/reloading; do not combine evidence from different browser/build sessions without noting it.

### 01 — Load the unpacked CapCam extension

- **ACTION:** After the automated preflight, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select this repository's `dist/` produced by the immediately preceding `npm run build:camera-test`. Open the extension's Details and verify its version and manifest permissions. Do not load a normal-build `dist/` for the Phase 06 bridge test.
- **EXPECTED RESULT:** CapCam loads as MV3 version 0.1.0 with minimum Chrome 116. The test-build page `chrome-extension://<extension-id>/tests/webrtc/offscreen-bridge.html` is available. Manifest permissions remain only `storage` and `offscreen`; no host permission or content-script injection is present.
- **EVIDENCE TO CAPTURE:** Screenshot of the extension card/details and load status; local `dist/manifest.json`; package/build command and browser version in run metadata.
- **PASS CONDITION:** Correct camera-test package loads without manifest errors, required test pages are present, and permissions match the existing least-privilege manifest.
- **FAILURE CONDITION:** Chrome is below 116; extension load error; missing bridge/consumer pages; wrong package was loaded; unexpected host/content-script permissions appear. Stop and record the exact error; do not compensate with broader permissions.

### 02 — Start CapCam and confirm the offscreen runtime

- **ACTION:** Click the CapCam toolbar action and wait for the popup's **Extension Ready**/runtime-ready status. Open the extension test page from the address bar using its exact `chrome-extension://<id>/tests/webrtc/offscreen-bridge.html` URL. Inspect the service worker through `chrome://extensions` → CapCam → **service worker / Inspect views**. Run the `chrome.runtime.getContexts()` probe above after the page has queried runtime state.
- **EXPECTED RESULT:** The popup and test page connect through the typed runtime protocol. The offscreen runtime reaches `READY`; exactly one `public/offscreen.html` `OFFSCREEN_DOCUMENT` context exists. No stream or media is claimed yet.
- **EVIDENCE TO CAPTURE:** Popup readiness screenshot; service-worker console output from `runtime.getContexts()`; extension test-page status/log; any startup errors.
- **PASS CONDITION:** Runtime is ready, one offscreen document is reported, and the test page can refresh offscreen state without a protocol/session error.
- **FAILURE CONDITION:** Runtime remains `UNKNOWN`/`ERROR`, no offscreen context appears after the state query, duplicate offscreen documents appear, or a startup/protocol error is logged.

### 03 — Select and ingest a local image

- **ACTION:** On `offscreen-bridge.html`, select the chosen local IMAGE A in **Add a local image/video source**, then click **Ingest source**. Keep the source selector visible and record the returned media record.
- **EXPECTED RESULT:** The image is decoded and reported `READY` with `kind: image`, dimensions, MIME type, and byte size. The file is staged locally; runtime messages carry a transfer ID, not the image bytes.
- **EVIDENCE TO CAPTURE:** Screenshot of selected record/status; sanitized event log; fixture metadata and SHA-256 in the run record.
- **PASS CONDITION:** One image record reaches `READY` with nonzero dimensions and the ingest request returns normally.
- **FAILURE CONDITION:** Decode/validation error, no record, invalid dimensions, unexpected audio/video track, runtime disconnect, or any claim that image bytes were sent through Chrome runtime messaging.

### 04 — Select and ingest a local video

- **ACTION:** Select the chosen local VIDEO B in the same file control and click **Ingest source**. Leave IMAGE A and VIDEO B loaded; explicitly choose IMAGE A again in the source selector before the first stream creation.
- **EXPECTED RESULT:** VIDEO B is reported `READY` with `kind: video`, dimensions, duration when available, MIME type, and byte size. Both media records remain selectable.
- **EVIDENCE TO CAPTURE:** Screenshot of both source options/records; sanitized video metadata; fixture codec/container and SHA-256.
- **PASS CONDITION:** The video decodes and reaches `READY`; both image and video can be selected without replacing or corrupting the other record.
- **FAILURE CONDITION:** Browser cannot decode the known fixture, metadata never becomes ready, either record disappears unexpectedly, or an error is hidden. If fixture codec support is the cause, record browser/OS/codec and mark the media subcheck FAIL or BLOCKED according to whether the fixture is known-supported.

### 05 — Create and start the offscreen media pipeline

- **ACTION:** Choose IMAGE A in **Current source**. Click **Create stream** and confirm its automatic `playback.getState` query returns the selected source in `READY`. Click **Play loaded source** and verify the PlaybackEngine reports `PLAYING`; then click **Start offscreen track** and refresh the combined playback/stream state. Record playback ID/state, stream ID, source media ID, render config, and track snapshot.
- **EXPECTED RESULT:** `stream.create` loads the selected source in the offscreen `PlaybackEngine` and creates the offscreen `CanvasStreamPipeline`; playback reports `READY`, then `PLAYING` after the explicit Play action, while stream state moves to `READY` and then `ACTIVE` after `stream.start`. The test page reports actual runtime states rather than inferring success from button clicks.
- **EVIDENCE TO CAPTURE:** Before/after `offscreen-state` JSON, extension test-page log, popup stream status, stream ID, configured width/height/FPS, and errors.
- **PASS CONDITION:** Playback reports `PLAYING` for IMAGE A, the same stream reaches `ACTIVE` and names IMAGE A as its source, and the runtime remains responsive.
- **FAILURE CONDITION:** `CREATE`/`START` errors, state does not become `ACTIVE`, source ID/config is inconsistent, or only a UI label changes without a matching runtime response.

### 06 — Verify Canvas rendering

- **ACTION:** With the offscreen stream active, inspect its resulting preview after Step 11. Confirm IMAGE A's labelled quadrants/colors and fit/crop orientation match the source. For VIDEO B, later switch sources in Step 17, start playback, and verify that the embedded frame counter changes. If inspecting the implementation directly, attach DevTools to the offscreen target (`chrome://inspect/#extensions`) and set a breakpoint in the loaded offscreen bundle at the `CanvasStreamPipeline` renderer call; record canvas dimensions and the `CanvasRenderer.render()` hit.
- **EXPECTED RESULT:** The offscreen renderer produces the expected pixels at the configured output dimensions, not a blank/black canvas or the wrong media item. Animated source changes are reflected over time.
- **EVIDENCE TO CAPTURE:** Screenshot of the extension and consumer previews with the fixture label visible; frame-counter clip or before/after images; optional DevTools breakpoint evidence for renderer invocation and canvas dimensions.
- **PASS CONDITION:** Expected IMAGE A pixels are visible on the real transferred output, and VIDEO B's output changes with its advancing frame counter after Step 17. Record whether the `CanvasRenderer.render()` call was directly inspected or only functionally inferred from captured output.
- **FAILURE CONDITION:** No image pixels, wrong source, wrong orientation/crop, black/frozen video output, or a renderer error. If the canvas surface itself could not be inspected, do not claim a direct canvas-object observation; note that limit separately.

### 07 — Verify `canvas.captureStream()`

- **ACTION:** In offscreen DevTools (`chrome://inspect/#extensions`), search the loaded `offscreen.js` bundle for `captureStream`. If the function is available in Sources, break at the native `canvas.captureStream(fps)` call, repeat stream creation in a fresh run, and record the canvas size and requested FPS. Step over the call and inspect that the returned value is a native `MediaStream`. Do not patch or replace the browser method.
- **EXPECTED RESULT:** The real offscreen call is reached with positive canvas dimensions and the configured FPS (currently 30 in this test page); it returns a native stream. Browser-returned track settings may differ or be unavailable and must be recorded as observed.
- **EVIDENCE TO CAPTURE:** DevTools call-stack/breakpoint screenshot or log showing the native call and return type; actual stream/track snapshot; any exception text.
- **PASS CONDITION:** The real `canvas.captureStream()` call is directly observed returning a `MediaStream` and the following Step 08/09 validations succeed.
- **FAILURE CONDITION:** Method unavailable, exception thrown, no native `MediaStream`, or no captured video track. If DevTools cannot expose the relevant call site, mark the isolated call-site check **UNVERIFIED**; downstream preview alone is not direct breakpoint evidence.

### 08 — Verify `MediaStream` creation

- **ACTION:** At the Step 07 breakpoint, step out to `StreamFactory.createFromCanvas()` and inspect the native value returned from `canvas.captureStream()`. Verify `stream instanceof MediaStream`, `stream.active`, and its `getTracks()`/`getVideoTracks()` counts before it is sent over either boundary. Do not copy it into Chrome runtime messaging or persistent state.
- **EXPECTED RESULT:** The offscreen document itself owns a native `MediaStream` created from the canvas. It is active and contains the expected track set before the BroadcastChannel probe is requested.
- **EVIDENCE TO CAPTURE:** Offscreen DevTools call-stack/return-value screenshot or copied sanitized object summary; stream active flag and track counts; any exception text.
- **PASS CONDITION:** The real offscreen return value is a native `MediaStream` and is active with exactly one video track and no audio track.
- **FAILURE CONDITION:** A non-`MediaStream` result, inactive stream, invalid track count, `captureStream()` exception, or inability to inspect the returned object. If DevTools cannot expose it, mark object-creation inspection **UNVERIFIED**; do not infer it from a UI label.

### 09 — Verify the captured video track

- **ACTION:** First inspect the track returned with the offscreen `MediaStream` at the Step 08 breakpoint. Complete the boundary observations after Step 11 by inspecting `#track-info` and `#offscreen-track-info` and running the frame-evidence probe. Record only `kind`, `readyState`, `enabled`, `muted`, width, height, frameRate, and aspectRatio; omit device/group IDs.
- **EXPECTED RESULT:** Exactly one video track and no audio track; `readyState: live` while active; actual settings are recorded as values or `null` (not replaced with requested values). Track label/ID are diagnostic only, not capability proof.
- **EVIDENCE TO CAPTURE:** Sanitized track snapshots from offscreen, extension, and localhost contexts, plus runtime state showing `ACTIVE`.
- **PASS CONDITION:** Offscreen and both page contexts report the expected real live video track, one video/zero audio, and safe settings fields with no validation error.
- **FAILURE CONDITION:** Missing/multiple/wrong-kind tracks, ended track before Stop, `UNKNOWN` treated as supported, or device-identifying settings leaked into the saved evidence.

### 10 — Verify offscreen runtime communication

- **ACTION:** In the extension test page click **Refresh runtime state**. Exercise the typed Ingest/Create/Start/Get State commands and correlate each UI update with the service-worker/offscreen logs. If investigating runtime API behavior, use the existing extension client or the documented serializable command envelope; do not send a `MediaStream`, frame, canvas, `File`, or media element through `chrome.runtime` messaging.
- **EXPECTED RESULT:** Commands and state snapshots cross the existing service-worker/offscreen runtime protocol; media bytes are handled through the local temporary handoff and only IDs/state are sent over runtime messages. Offscreen logs identify the lifecycle and the test-only bridge.
- **EVIDENCE TO CAPTURE:** Service-worker and offscreen console logs, command/result request IDs, before/after stream state, and a note that no media object was placed in a runtime message.
- **PASS CONDITION:** Each typed command returns a correlated result and the offscreen context's state matches the extension page's state.
- **FAILURE CONDITION:** Timeout, session mismatch, state disagreement, serialization failure in runtime messaging, or a raw media object/frame sent through the runtime protocol.

### 11 — Verify offscreen → extension page → controlled consumer transfer

- **ACTION:** With the active stream and exact local consumer open, click **Request offscreen MediaStream** on the canonical `offscreen-bridge.html` page. Observe all three locations: offscreen BroadcastChannel response, extension-page receipt, then exact-origin `window.postMessage` to the localhost page. Confirm the consumer's `event.origin` is the extension origin and `event.source` is its opener; the canonical page fixes the consumer URL to `http://localhost:5173/tests/webrtc/web-consumer.html`. Download the Phase 06 JSON report after this and later lifecycle/cleanup observations.
- **EXPECTED RESULT:** The versioned `BroadcastChannel` transfers the actual offscreen stream to the extension page; the extension page forwards it with the exact localhost `targetOrigin`; the normal localhost page receives it in its page JavaScript context and acknowledges the matching request.
- **EVIDENCE TO CAPTURE:** Matching request IDs and timestamps in offscreen/extension/consumer logs; page origin/opener origin; sanitized track snapshots at each boundary; DevTools console errors if any.
- **PASS CONDITION:** The same test request completes each boundary with a validated response and a native stream/track in the localhost page; no runtime message transports the media.
- **FAILURE CONDITION:** Missing boundary response, `DataCloneError`, `messageerror`, origin/source/request ID mismatch, accepted message from an untrusted sender, or the stream reaches only an extension page but not localhost.

### 12 — Verify actual frame reception

- **ACTION:** Inspect the canonical page's Phase 06 evidence report for automatic `requestVideoFrameCallback` counts from `#extension-preview` and the localhost `#offscreen-preview`; it requires actual presented frames in both contexts and separately records `play()` state. Optionally run the `capcamVideoEvidence()` DevTools probe below for an independent sample. Later repeat for VIDEO B after playback starts; if using a local WebRTC call, also run it for `#remote-preview`.
- **EXPECTED RESULT:** Each active preview reports a native `MediaStream`, a live video track, nonzero video dimensions once frames are decoded, and observed presented frames. VIDEO B should show an advancing frame counter and advancing media time while playing.
- **EVIDENCE TO CAPTURE:** Probe outputs, screenshot(s) with the source label/counter visible, and console logs from both pages.
- **PASS CONDITION:** At least one actual frame is presented in both extension and consumer previews; for VIDEO B and a WebRTC remote preview, multiple frames are observed and the counter/time advances.
- **FAILURE CONDITION:** Stream/track exists but zero frames are presented, dimensions stay zero, counter is frozen while playback is expected, or the remote receiver remains empty. Do not treat `track.readyState === "live"` alone as frame evidence.

### 13 — Verify visible playback

- **ACTION:** Verify IMAGE A is visibly displayed in both previews. For VIDEO B, select it in the CapCam popup's **Source**, click **Play**, and verify playback status/time advances; ensure the offscreen canvas and localhost preview show VIDEO B rather than a still from IMAGE A. Start **Add received CapCam track** in the consumer to inspect the remote controlled WebRTC receiver preview.
- **EXPECTED RESULT:** The extension and localhost `<video>` elements visibly render the captured output; VIDEO B's motion reaches the page. If a local peer is started, its remote preview shows the received track. No production site's camera UI or virtual-device selector is involved.
- **EVIDENCE TO CAPTURE:** Screenshots of extension/local/remote previews; popup playback state/time; sanitized frame-probe results; consumer receiver track and peer states.
- **PASS CONDITION:** A human can see the correct source in the consumer preview; VIDEO B motion advances; where `addTrack` is exercised, the second local peer receives and visibly plays the track.
- **FAILURE CONDITION:** Blank/frozen/wrong-source output, no page playback, no `ontrack`/remote preview when addTrack is expected, or evidence consists only of a successful API call without visible frames.

### 14 — Verify track lifecycle

- **ACTION:** With a transferred active stream, click **Stop** on the canonical page; it polls bounded source/extension/consumer track-state snapshots and records any actual consumer `track-ended` event. Then click **Restart**, request the active stream again after it returns to `ACTIVE`, and verify the new transfer. The JSON report stays UNVERIFIED until it observes the old tracks ended and a distinct live replacement track; do not expect an ended track to revive.
- **EXPECTED RESULT:** Stop moves the stream to `STOPPED` and ends the old capture track. Restart creates a live capture track and returns to `ACTIVE`; the old track stays ended. Any old consumer clone is treated as stale and replaced only through a new validated request.
- **EVIDENCE TO CAPTURE:** Before/after stream and track snapshots, start/stop/restart logs, new request IDs, and frame probe after restart.
- **PASS CONDITION:** Old track is `ended`; restarted track is a new live capture object/track as observed; new frames arrive after re-request; no stale track is reported as live.
- **FAILURE CONDITION:** Old track remains live after stop, restart reports active with no live video, old track is silently reused as if revived, or duplicate loops/tracks accumulate.

### 15 — Verify cleanup (run last, after Steps 16–19)

- **ACTION:** Close the local call with **Close call and clean up** if one was started. Then on the canonical `offscreen-bridge.html` click **Dispose**. Wait for the bounded consumer acknowledgement before the extension page disposes the offscreen stream and removes its ingested sources. Once the acknowledgement is recorded, close the localhost consumer tab while leaving the extension test page open; its pagehide/disconnect diagnostic is captured in the JSON. Inspect the acknowledgement and final state, then download the Phase 06 report. For the separate offscreen-document shutdown check, use the popup's DevTools console with the existing protocol envelope, then re-run the `getContexts()` probe:

  ```js
  const sendCapCam = (type) => chrome.runtime.sendMessage({
    protocol: 1,
    requestId: `req_${crypto.randomUUID()}`,
    type,
  });
  await sendCapCam("runtime.getState");
  await sendCapCam("runtime.shutdown");
  ```

  After capturing the zero-context result, if continuing the run, evaluate `await sendCapCam("runtime.initialize")` and repeat the context/session check. Do not assume a track survives offscreen-document destruction.
- **EXPECTED RESULT:** Consumer acknowledgement reports `completed: true`, integration `OFF`, peer connections closed, local page-owned tracks ended, and `error: null`. The offscreen stream and test sources are disposed; the runtime document remains until explicitly shut down. Explicit shutdown reports stopped and removes the offscreen context; a later initialize creates one fresh context/session.
- **EVIDENCE TO CAPTURE:** Full validated cleanup acknowledgement, final stream/media state, old track states, console logs, `getContexts()` counts before/after runtime shutdown and after initialize.
- **PASS CONDITION:** Every owned peer/track/resource reaches its expected terminal state; no active preview/track remains; explicit runtime shutdown reaches zero contexts and initialize creates a new session. No timeout or cleanup error is hidden.
- **FAILURE CONDITION:** Missing/invalid acknowledgement, peers or local tracks remain active, timeout, leaked source/stream, stale runtime state, shutdown reports success while context remains, or cleanup errors are suppressed. If the consumer has already navigated away and cannot acknowledge, record that outcome and rely on the explicit failure/timeout evidence; do not call it acknowledged cleanup.

### 16 — Verify popup closing and reopening

- **ACTION:** While the offscreen stream is `ACTIVE` and VIDEO B is playing, close the popup by clicking outside it. Wait several seconds, reopen CapCam from the toolbar, and use its refresh control. Do not stop or dispose the stream between popup instances.
- **EXPECTED RESULT:** Popup closure does not own or destroy the long-running offscreen pipeline. On reopening, the popup re-queries the same active stream/runtime and shows current playback/stream state; the consumer preview continues.
- **EVIDENCE TO CAPTURE:** Stream/track IDs and state immediately before close and after reopen; continuous frame-probe samples/screenshots; popup and service-worker logs.
- **PASS CONDITION:** Same active stream remains usable, no unintended Stop/Dispose occurs, and video continues through popup close/reopen.
- **FAILURE CONDITION:** Closing the popup ends the offscreen track, stops the renderer/playback unexpectedly, or reopening reports a different/stale state without a legitimate restart.

### 17 — Verify source switching

- **ACTION:** With one stream active and both IMAGE A/VIDEO B ingested, choose VIDEO B in the canonical `offscreen-bridge.html` → **Current source** and click **Switch active source**. Confirm PlaybackEngine reloads VIDEO B, then click **Play loaded source** on the same page (the popup Play control is an equivalent independent check). Verify both previews and the counter, then switch back to IMAGE A and observe them again.
- **EXPECTED RESULT:** The existing offscreen canvas stream/track is retained while `sourceMediaId` changes. IMAGE A → VIDEO B changes visible content and motion without creating a second pipeline; VIDEO B → IMAGE A returns to the still image. Playback source may need an explicit Play click after switching.
- **EVIDENCE TO CAPTURE:** Stream ID and track ID before/after each switch; source media IDs; frame-counter/screenshot evidence; popup/consumer state and logs.
- **PASS CONDITION:** Source ID changes to the selected record, same active stream/track is retained, correct new pixels/frames appear, and the consumer connection remains usable.
- **FAILURE CONDITION:** Wrong source appears, switch errors or disposes/recreates the stream unexpectedly, track changes/ends without explanation, frames freeze, or source selector/state disagree.

### 18 — Verify disable/re-enable on the controlled sender

- **ACTION:** This subtest requires an available camera. In the localhost consumer, explicitly click **Request native camera permission** and respond to Chrome's normal page-level prompt. Start **WebRTC with native camera**. Click **Enable CapCam on sender**, verify remote output, click **Disable CapCam · restore native camera**, and verify the original still-live native track is back. Repeat enable → disable once more. Do not use camera flags or modify `getUserMedia`.
- **EXPECTED RESULT:** Native `getUserMedia({audio:false, video:true})` remains untouched. Only the controlled localhost `RTCRtpSender` changes track on explicit clicks. Disable restores the original live native sender track; re-enable succeeds with a live CapCam track. The browser's ordinary camera permission control remains in effect.
- **EVIDENCE TO CAPTURE:** Permission choice; original/CapCam/restored sender IDs and states; `CameraIntegration` logs/status; peer signaling/connection states; visible remote preview and frame probes. Redact camera/device identifiers.
- **PASS CONDITION:** Both ON/OFF cycles complete in the controlled page, sender identity matches the requested live track each time, native track is restored and remains live, and remote video visibly follows the source.
- **FAILURE CONDITION:** Permission is bypassed, `getUserMedia` is patched, track kind/state mismatches, original live track is not restored, sender/remote output disagrees, or the local page modifies a non-test origin. If no camera is available or permission is denied, record **BLOCKED / UNVERIFIED** for this check; do not circumvent it.

### 19 — Verify page reload/navigation behavior

- **ACTION:** With the extension test page and active stream open, reload `web-consumer.html`. Wait for the new exact-origin ready handshake and confirm the extension page resends the current stream only after readiness. Then navigate the consumer only among controlled localhost test pages or close/reopen it through **Open local consumer tab**. Separately reload the extension test page, reopen/reload the controlled consumer to force a fresh handshake, and request the current stream again. Do not navigate to or test a production site.
- **EXPECTED RESULT:** A reloaded consumer document starts with no stale local track, repeats the opener-origin handshake, then receives a current native stream/track and visible frames. Reloading the extension page does not assert that its old page clone survives; it re-queries runtime state and requires a fresh consumer handshake/request. Navigation away may prevent an acknowledgement and should be diagnosed honestly.
- **EVIDENCE TO CAPTURE:** Old/new page logs and request IDs; handshake origin/source; stream/track snapshots before/after; current context count; any bounded cleanup timeout or `messageerror`.
- **PASS CONDITION:** Fresh documents establish the validated handshake and receive a live current stream only after the explicit request; no stale clone is treated as supported. Any away-navigation timeout is recorded as a timeout, not cleanup success.
- **FAILURE CONDITION:** Old track is shown as live after reload, new page accepts without the handshake, stale/mismatched request is accepted, page reload silently creates duplicate offscreen pipelines, or navigation affects an unrelated site.

## Evidence checklist — current run

All items below are intentionally **NOT RUN** until a qualifying real browser session is available. Tick `PASS` only after saving the evidence named in the corresponding step. Use `FAIL`, `BLOCKED`, or `UNVERIFIED` where appropriate and note why.

- [ ] Run metadata complete; browser product/version/channel and OS recorded.
- [ ] 01 Load unpacked camera-test extension — status: **NOT RUN** — evidence:
- [ ] 02 Start extension/offscreen runtime — status: **NOT RUN** — evidence:
- [ ] 03 Local image selection/ingest — status: **NOT RUN** — evidence:
- [ ] 04 Local video selection/ingest — status: **NOT RUN** — evidence:
- [ ] 05 Offscreen pipeline create/start — status: **NOT RUN** — evidence:
- [ ] 06 Canvas rendering — status: **NOT RUN** — evidence:
- [ ] 07 Native `canvas.captureStream()` call — status: **NOT RUN** — evidence:
- [ ] 08 Native `MediaStream` creation/transfer — status: **NOT RUN** — evidence:
- [ ] 09 Single live video track/settings — status: **NOT RUN** — evidence:
- [ ] 10 Typed offscreen runtime communication — status: **NOT RUN** — evidence:
- [ ] 11 Offscreen → extension → localhost transfer — status: **NOT RUN** — evidence:
- [ ] 12 Actual presented frames at each boundary — status: **NOT RUN** — evidence:
- [ ] 13 Visible playback / local `addTrack()` receiver — status: **NOT RUN** — evidence:
- [ ] 14 Stop/restart track lifecycle — status: **NOT RUN** — evidence:
- [ ] 15 Consumer/stream/source/runtime cleanup — status: **NOT RUN** — evidence:
- [ ] 16 Popup close/reopen while stream active — status: **NOT RUN** — evidence:
- [ ] 17 Image↔video source switch continuity — status: **NOT RUN** — evidence:
- [ ] 18 Explicit native-camera sender disable/re-enable — status: **NOT RUN** — evidence:
- [ ] 19 Controlled consumer/extension-page reload/navigation — status: **NOT RUN** — evidence:
- [ ] Console errors and cleanup timeouts reconciled; no unresolved failure hidden.
- [ ] Evidence is local/sanitized; no raw frames, device IDs, or personal media shared.

## Existing automated verification (not browser evidence)

The current workspace reports the following code/package checks as complete: **39 test files, 151 tests passed; 10 focused local-consumer protocol tests passed; typecheck, lint, normal build, and camera-test build passed.** These tests/builds are not a Chrome run and do not satisfy any checklist row above. Re-run the automated preflight in the target environment before the browser run and record its actual output.

## Remaining blocker and phase status

The current environment has no usable Chrome/Chromium executable or headed browser control, so no extension was loaded and none of the 19 browser checks has evidence. Structured cloning of the actual offscreen `MediaStream`, visible consumer frames, page-world receipt, WebRTC delivery, and cleanup acknowledgement remain **UNVERIFIED** until this run is executed in real Chrome.

**Do not mark Phase 06 PASS from this runbook, automated tests, mocks, static review, or builds.** A future operator must capture and review the real-browser evidence and update the authoritative results record explicitly. This document does not alter that gate.

**PHASE 06 = BLOCKED / UNVERIFIED**

**PHASE 07 = BLOCKED**
