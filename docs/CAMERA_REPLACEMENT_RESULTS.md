# CapCam Phase 06 — Camera Replacement Prototype Results

**Report date:** 2026-10-03  
**Phase status:** **BLOCKED — Chrome browser experiments not run.**  
**Technical verdict:** **UNDETERMINED.** None of `SUPPORTED PATH`, `CONTROLLED-WEBRTC ONLY`, or `ARCHITECTURE BLOCKED` is asserted as an empirical result. This is a test-environment block, not evidence that the architecture itself is blocked.

## Summary

Phase 06.1 documentation research, source/API compatibility review, the local test pages, and a test-build-only offscreen stream bridge are in place. I attempted to start the requested real-browser validation on this workspace, but it is Linux (`6.1.158+ x86_64`) and no Chrome/Chromium executable was available: `command -v` found none of `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, or `chrome`, and a file search under `/usr/bin`, `/opt`, and `/usr/local/bin` found no browser binary. No browser-control interface is available here either. Thus no extension was loaded and no Chrome page, camera prompt, browser `MediaStream`, or `RTCPeerConnection` was observed.

**All requested browser tests are recorded as NOT RUN, not as runtime failures.** There is no Chrome version, permission outcome, measured track, sender/receiver state, or remote video to report. The target-site stage remains unstarted. There is no product-level `getUserMedia()` replacement or production-site adapter.

## Requested Phase 06 browser run — Tests 1–10

The attempt was blocked before launch because Chrome/Chromium is unavailable in this execution environment. No test page was opened, no permissions were granted, and no MediaStream/WebRTC objects were created. `NOT RUN` below must not be interpreted as PASS or FAIL.

| Test | Page/path intended | Actual result and evidence |
|---|---|---|
| 1 — CapCam stream → local video | `tests/webrtc/offscreen-bridge.html` → `tests/webrtc/web-consumer.html` | **NOT RUN** — no extension was loaded. `track.kind`, `id`, `readyState`, `enabled`, `getSettings()`, width, height, and frameRate: **not observed**; no visible-frame evidence. |
| 2 — CapCam track → `addTrack()` | Controlled peers in `tests/webrtc/web-consumer.html` | **NOT RUN** — negotiation, sender/receiver IDs, receiver kind/state, remote playback, and errors: **not observed**. |
| 3 — `replaceTrack()` | Controlled local sender and remote peer | **NOT RUN** — return/error, before/after sender track, before/after remote video, connection/ICE/signaling states: **not observed**. |
| 4 — Stream switching | CapCam Image A → CapCam Video B | **NOT RUN** — connection continuity, remote frames, old-track stop, and new-track state: **not observed**. |
| 5 — Cleanup | Transmit, stop CapCam, inspect peer/runtime | **NOT RUN** — track end, sender/receiver/peer states, animation-loop count, DOM/resource cleanup, and runtime errors: **not observed**. |
| 6 — Restart | Start → transmit → stop → start → transmit → stop | **NOT RUN** — no cycles executed; duplicate/stale resource behavior: **not observed**. |
| 7 — Image → video | Image source → remote, switch to video → remote | **NOT RUN** — remote frames before/after switch: **not observed**. |
| 8 — Extension/page context | Intended offscreen → extension page → localhost page path | **NOT RUN in Chrome** — source-design context is described below; actual object transfer/context: **not observed**. |
| 9 — Page `getUserMedia()` | `tests/webrtc/basic-camera.html` native baseline | **NOT RUN** — page result and whether extension code can affect it: **not observed**. No isolated-world behavior is inferred. |
| 10 — Repeatability | Ten create → attach/replace → transmit → stop → cleanup runs | **NOT RUN** — runs attempted: **0/10**; successes: **0**; failures: **0**; remaining: **10**. These zero counts mean no test executions, not ten failed trials. |

### Test 8 — source-design context only (not observed runtime evidence)

- Stream intended to be created in: the extension offscreen document (`public/offscreen.html`).
- Track intended to be consumed by: the extension test page via the camera-test BroadcastChannel response, then by the localhost consumer page.
- PeerConnection intended to be created in: the localhost page for the received offscreen track; the separate page-owned harness has its own controlled peers.
- Intended contexts: extension offscreen document, extension test page, and localhost page. No content-script-only shim is treated as page-world evidence.
- Intended bridge: same-extension-origin `BroadcastChannel`, followed by exact-origin `window.postMessage()` to localhost.
- **Observed in Chrome:** none. The structured-clone transfers, page-world receipt, and effects on page-owned `getUserMedia()` remain unverified.

## Browser experiment matrix

| Test | Required success evidence | Observed result |
|---|---|---|
| Native camera baseline — `basic-camera.html` | User-permissioned native `getUserMedia({ video: true })`; returned page-world track is visible and settings/state recorded. | **NOT RUN** — no Chrome/Chromium. |
| Page-owned CapCam stream — `capcam-stream.html` | Existing canvas capture pipeline returns a live video track displayed by the page. | **NOT RUN** — harness built; no browser runtime. |
| Page-to-page `MediaStream` clone — visible iframe in `capcam-stream.html` | `window.postMessage` receiver confirms `instanceof MediaStream`, a live video track, and visible playback; record synchronous clone errors or `messageerror`. | **NOT RUN** — structured cloning remains unverified. |
| Controlled `addTrack()` — `loopback.html` | `addTrack()` succeeds; receiving peer's `ontrack` fires and remote video displays. | **NOT RUN** — no Chrome WebRTC experiment. |
| Controlled camera-to-generated `replaceTrack()` — `replace-track.html` | Native camera is the original sender; replacement is a same-kind generated track; sender details and remote video are inspected. | **NOT RUN** — API compatibility/mock behavior is not counted as success. |
| Actual offscreen stream → extension test page | In `build:camera-test`, offscreen BroadcastChannel response is a real `MediaStream`; extension page receives/displays its actual live track. | **NOT RUN** — the most important cross-context claim remains unresolved. |
| Extension test page → localhost page-world receiver | The normal localhost page receives a native `MediaStream` through exact-origin `window.postMessage`, displays the track, and reports its own track state/settings. | **NOT RUN** — no receiver page was run in Chrome. |
| Actual offscreen track `addTrack()` in localhost page | The page that received the offscreen track attaches it to its local sender; remote loopback video displays. | **NOT RUN**. |
| Actual offscreen track `replaceTrack()` in localhost page | A separately acquired native camera track is replaced with the received offscreen track; sender identity and remote output are checked. | **NOT RUN**. |
| Permission/lifecycle/reliability | Permission denied/revoked, repeated create-stop-restart-transfer cycles, source switching, cleanup, and offscreen destruction/recreation are observed. | **NOT RUN**. |
| Approximate performance | Browser-measured frame/track settings and any relevant `getStats()` values are captured. | **NOT MEASURED**. |
| Target-site experiment | One authorized target examined only after controlled tests pass; no adapter or manipulation of unrelated production WebRTC. | **DEFERRED / NOT RUN**. |

## What the harness contains

- `tests/webrtc/basic-camera.html` separately records native camera acquisition; no method override is installed.
- `tests/webrtc/capcam-stream.html` instantiates the existing canvas stream pipeline in a visible page and includes a real iframe receiver for a same-origin structured-clone probe. It clearly labels that stream as page-owned, not the production offscreen stream.
- `tests/webrtc/loopback.html` tests application-controlled `RTCPeerConnection.addTrack()` with two local peers.
- `tests/webrtc/replace-track.html` begins with a native camera sender and explicitly calls `RTCRtpSender.replaceTrack()` with a page-owned generated track.
- `tests/webrtc/offscreen-bridge.html` uses the existing `MediaIngestClient`/temporary IndexedDB file handoff and typed runtime commands to generate the **actual** Phase 05 offscreen stream. Only the separate `npm run build:camera-test` output activates the versioned BroadcastChannel listener.
- `tests/webrtc/web-consumer.html` is a normal localhost page. The extension test page opens it with a fixed localhost-only origin; it verifies its own receipt and visible playback, and has explicit `addTrack()` and native-camera-to-CapCam `replaceTrack()` actions.
- The standard `npm run build` omits the `tests/webrtc/` pages, the exact test-page sender authorization, and the offscreen BroadcastChannel bridge. Only `npm run build:camera-test` contains these explicitly test-only pieces. No host permissions, tab permission, scripting permission, content-script changes, external signaling, or new runtime dependency were added for the test path.

The explicit test build attempts to pass the actual offscreen `MediaStream` only through browser-native structured cloning over `BroadcastChannel`, then exact-origin `window.postMessage`. Whether either transfer succeeds in Chrome remains unverified. The stream is not sent through Chrome runtime messaging, settings, IndexedDB, or persistent state; the normal Phase 05 runtime protocol continues to carry only IDs and serializable state/track records.

## Automated validation (not browser evidence)

The npm test suite, TypeScript check, lint, normal extension build, special camera-test build, package-artifact assertions, and `git diff --check` were run separately from Chrome experiments. **These automated checks validate source/type/protocol shape and package output only; they do not validate media transfer or WebRTC behavior.** Final automated results:

- `npm test -- --reporter=dot`: **PASS — 36 test files, 125 tests**.
- `npm run typecheck`: **PASS**.
- `npm run lint`: **PASS**.
- `npm run build:camera-test`: **PASS**; artifact assertions found all eight controlled WebRTC pages, the versioned bridge/listener, and the exact test-page sender URL.
- `npm run build`: **PASS**; artifact assertions confirmed the WebRTC pages, bridge code, and test-page authorization are absent from normal `dist/`.
- `git diff --check`: **PASS**.

These are automated source/package results only. The browser experiment matrix remains **NOT RUN**.

## Technical decision

**Required conclusion: C — PHASE 06 — BLOCKED.** The underlying stream/WebRTC capability remains **UNDETERMINED**, because no real Chrome experiment could be started. “Blocked” here reports the missing browser evidence; it is not proof that the architecture is impossible.

**Phase 07 unblocked: NO.** Do not begin target-site compatibility work until the required controlled Chrome path is actually demonstrated.

Documented constraints narrow the question but do not answer the empirical one:

- Chrome runtime messaging is not a live-media transport.
- The offscreen document has no `window.opener`, and it exposes only Chrome's `runtime` extension API.
- `BroadcastChannel` is a plausible same-extension-origin browser-supported experiment; its ability to clone this actual offscreen stream in CapCam's Chrome build has not been tested.
- `window.postMessage` with a strict localhost origin is a second controlled experiment; it has not been tested with the actual offscreen stream.
- Standard WebRTC track attachment/replacement is distinct from changing what a page's native `getUserMedia()` returns.

The test-only bridge and local pages remain experiments, not a product support decision. No result here proves the architecture works or cannot work; only a Chrome run can resolve that.

## Run environment and final status

- Validation attempt date: **2026-10-03**
- Chrome version/channel: **not available — no Chrome/Chromium executable installed in this workspace**
- Browser discovery: `command -v` checked `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, and `chrome` (none found); `find` under `/usr/bin`, `/opt`, and `/usr/local/bin` found no browser binary.
- OS: **Linux x86_64**, kernel `6.1.158+` (`e2b.local`)
- Extension/package version: **0.1.0** in `package.json` and `manifest.json`; the `camera-test` build was **not loaded into Chrome**.
- Test page used: **none** — no browser available. Intended pages: `tests/webrtc/offscreen-bridge.html`, `tests/webrtc/web-consumer.html`, `tests/webrtc/loopback.html`, `tests/webrtc/replace-track.html`, and `tests/webrtc/basic-camera.html`.
- Permission outcome, stream/track settings, negotiation/sender/receiver state, remote playback: **not observed**.
- Screenshots / Chrome logs: **none**. No page was run, so there are no runtime errors to report.
- Test-site experiments: **not started**.
- Required final choice: **C — PHASE 06 — BLOCKED**.
- Phase 07 unblocked: **NO**.

## Next required action

Run `docs/DEVELOPMENT.md` → **Phase 06 local WebRTC feasibility harness** in Chrome 116+ (preferably current stable). First verify the ordinary local tests, then the actual offscreen → extension page → localhost page chain. Record actual object identity/type, track `readyState`/settings, visible page and receiver video, sender identity, stop/restart/source-switch cleanup, and any permission or clone errors. Do not begin a target-site experiment unless the controlled browser tests first pass and the site experiment remains within the explicit local-first/safety boundaries.
