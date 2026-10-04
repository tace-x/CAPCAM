# CapCam

CapCam is a **local-first Manifest V3 Chrome extension** that routes local image and video media into an offscreen canvas rendering pipeline and integrates with controlled WebRTC target senders. Media processing remains entirely on-device within the browser.

---

## What CapCam Is and Is NOT

### What CapCam IS:
- A **local-first Chrome extension (MV3)** utilizing an offscreen document runtime to render user-selected images and videos.
- A **deterministic canvas stream pipeline** creating video tracks via `HTMLCanvasElement.captureStream()`.
- An **explicit, controlled WebRTC target integration** that replaces video sender tracks in detected target peer connections with exact origin permission checks.
- A **privacy-first local tool** requiring no cloud servers, backend APIs, analytics, or user tracking.

### What CapCam is NOT:
- **NOT a system-level virtual webcam driver** (e.g. OBS Virtual Camera, ManyCam, v4l2loopback).
- **NOT a universal `getUserMedia()` monkey-patch** or arbitrary-site DOM injector.
- **NOT a cloud service or media streaming platform**.
- **NOT a broad-permission extension**: requests only least-privilege `storage` and `offscreen` permissions without `<all_urls>` or wildcards.

---

## Architecture Overview

```text
┌────────────────────────────────────────────────────────┐
│                      Popup UI                          │
│  - React 19 control surface (client-only)              │
│  - Transport strip, presets, mirror, loop, shortcuts   │
└───────────────────────────┬────────────────────────────┘
                            │ Typed Protocol v1 Messages
┌───────────────────────────▼────────────────────────────┐
│              Background Service Worker                 │
│  - Lifecycle coordinator & request router              │
│  - Chrome storage settings manager                     │
│  - Offscreen document lifecycle manager                │
└───────────────────────────┬────────────────────────────┘
                            │ BroadcastChannel / Port
┌───────────────────────────▼────────────────────────────┐
│                 Offscreen Document                     │
│  - MediaEngine: Local blob ingest, metadata, registry  │
│  - PlaybackEngine: Video/image timing and transport    │
│  - CanvasStreamPipeline: Frame scheduling & transforms │
│  - CaptureStream: MediaStreamTrack generation          │
└───────────────────────────┬────────────────────────────┘
                            │ Controlled Video Track Transfer
┌───────────────────────────▼────────────────────────────┐
│             WebRTC Target Integration                  │
│  - Exact origin permission validation                  │
│  - Single controlled RTCRtpSender discovery            │
│  - Reversible track replacement & restoration          │
└────────────────────────────────────────────────────────┘
```

---

## Installation & Developer Quickstart

### 1. Requirements
- Node.js 20+
- npm 10+
- Google Chrome 116+ (supports MV3 Offscreen Documents)

### 2. Setup
```sh
npm ci
```

### 3. Development Commands
```sh
npm test                 # Run complete Vitest suite (49 files, 257 tests)
npm run lint             # Run ESLint validation
npm run typecheck        # Run TypeScript type check
npm run dev              # Start Vite local development server
npm run build            # Build standard Chrome extension in dist/
npm run build:camera-test # Build camera integration test harness
npm run verify:release   # Run pre-release artifact and security verification
npm run package          # Build, verify, and zip release archive (release/capcam-v0.1.0.zip)
```

### 4. Loading the Extension in Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked** and select the `dist/` directory (after running `npm run build`).
4. Pin CapCam in your extension toolbar and click the icon to open the popup control surface.

---

## Controlled Camera Test Harness

For local testing of WebRTC track replacement and MediaStream routing without modifying external websites:

1. Build the test mode bundle:
   ```sh
   npm run build:camera-test
   ```
2. Start the local server:
   ```sh
   npm run dev
   ```
3. Open `http://localhost:5173/tests/webrtc/index.html` to access the controlled testing suite (Loopback, Track Replacement, CapCam Stream, and Transfer Receiver).

---

## Keyboard Shortcuts (Popup)

| Shortcut | Action |
| --- | --- |
| `Space` | Play / Pause active video playback |
| `R` / `r` | Restart playback from beginning |
| `M` / `m` | Toggle horizontal stream mirror |
| `C` / `c` | Toggle Camera ON / OFF (when permitted) |
| `Esc` | Close dialogs / Dismiss error banners |
| `?` | Open keyboard shortcuts cheatsheet |

---

## Current Status & Roadmap Verification

| Phase | Milestone | Status |
| --- | --- | --- |
| **01** | MV3 Foundation & Protocol | **COMPLETE** |
| **02** | Local Media Engine & Ingestion | **COMPLETE** |
| **03** | Canvas Pipeline & CaptureStream | **COMPLETE** |
| **04** | Playback Engine & Transport | **COMPLETE** |
| **05** | Managed Offscreen Runtime | **COMPLETE** |
| **06** | Browser Transfer Verification | **EMPIRICALLY VERIFIED (CROSS-CONTEXT CLONE BLOCKED IN CHROMIUM)** |
| **07** | Production Camera Integration | **IMPLEMENTED (IN-PAGE TARGET ADAPTER VERIFIED)** |
| **08** | Lifecycle Hardening & Recovery | **COMPLETE** |
| **09** | Real-State-Driven Popup Surface | **COMPLETE** |
| **10** | Settings, A11y & UX Polish | **COMPLETE** |
| **11** | Performance, Security & Soak Audit | **COMPLETE** |
| **12** | Release Packaging & Distribution | **COMPLETE** |

> **Note on Browser Verification:**
> All implementation and automated unit/integration/stress/security tests (257 tests across 49 files) pass 100%. Controlled WebRTC sender replacement and canvas capture pipeline are verified in real headed Chrome 154 on macOS. `PHASE_06_VERIFIED` remains `false` in `src/config/capabilities.ts` because Chromium blocks cross-context `MediaStream` cloning over `BroadcastChannel` with `DataCloneError`, which CapCam circumvents through its in-page `GenericWebRtcTargetAdapter`.

---

## License

MIT License. See LICENSE for details.
