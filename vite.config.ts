import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

const standardInputs = {
  popup: resolve(root, "popup.html"),
  "developer-test": resolve(root, "developer-test.html"),
  offscreen: resolve(root, "public/offscreen.html"),
  background: resolve(root, "src/background/index.ts"),
  content: resolve(root, "src/content/index.ts"),
};

const cameraTestInputs = {
  "tests/webrtc/index": resolve(root, "tests/webrtc/index.html"),
  "tests/webrtc/basic-camera": resolve(root, "tests/webrtc/basic-camera.html"),
  "tests/webrtc/capcam-stream": resolve(root, "tests/webrtc/capcam-stream.html"),
  "tests/webrtc/loopback": resolve(root, "tests/webrtc/loopback.html"),
  "tests/webrtc/replace-track": resolve(root, "tests/webrtc/replace-track.html"),
  "tests/webrtc/transfer-receiver": resolve(root, "tests/webrtc/transfer-receiver.html"),
  "tests/webrtc/offscreen-bridge": resolve(root, "tests/webrtc/offscreen-bridge.html"),
  "tests/webrtc/web-consumer": resolve(root, "tests/webrtc/web-consumer.html"),
};

export default defineConfig(({ mode }) => ({
  root,
  base: "./",
  publicDir: false,
  plugins: [react()],
  server: {
    allowedHosts: [".e2b.app"],
  },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    target: "chrome109",
    rollupOptions: {
      input: mode === "camera-test"
        ? { ...standardInputs, ...cameraTestInputs }
        : standardInputs,
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
