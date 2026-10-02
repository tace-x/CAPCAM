# Development Guide

## Prerequisites

- Node.js 20.19+ (or a compatible current LTS) and npm.
- Google Chrome 116+ for the offscreen document detection API used by the recovery manager.

## Install and validate

```sh
npm install
npm run dev
npm run build
npm run test
npm run lint
npm run typecheck
```

`npm run dev` serves the popup shell with Vite for UI iteration; Chrome extension APIs are only available in the loaded extension, so the popup reports a connection error when run as an ordinary web page. `npm run build` creates a package in `dist/` and copies the manifest/icons.

## Load the extension

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this project's `dist/` directory.
5. Pin/open CapCam from the extensions menu.

Only the `storage` and `offscreen` permissions are requested. The content entry is intentionally not registered and no host permissions are needed in Phase 01.

## Debugging

- **Service worker:** open `chrome://extensions`, locate CapCam, and click the **service worker / Inspect views** link. Check the Console for `[CapCam][Runtime]` and protocol/storage diagnostics.
- **Offscreen document:** from `chrome://extensions`, inspect extension views when available, or open `chrome://inspect/#extensions` and inspect the CapCam offscreen page. Its DevTools console uses the `[CapCam][Offscreen]` prefix. The document is created when the extension runtime initializes and closed after `offscreen.shutdown`.
- **Popup:** right-click the popup and choose **Inspect**. The popup reports a structured connection error when it cannot reach the extension runtime.
- **Storage:** inspect the extension's local storage through extension DevTools/Application tools. Settings are stored under `capcam.settings.v1`; clearing extension storage restores defaults.

## Build output

The manifest points at `background.js` and `popup.html`; Vite also emits the offscreen page and a future content entry. Use `dist/` as the unpacked extension root. Generated files and dependencies are excluded from version control.

## Scope reminders

Do not add camera interception, site-specific host permissions, decoding, canvas frame generation, or `captureStream` in Phase 01. New commands must be typed, validated, documented, and tested before they are exposed.
