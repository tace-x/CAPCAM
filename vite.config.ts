import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
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
      input: {
        popup: resolve(root, "popup.html"),
        offscreen: resolve(root, "public/offscreen.html"),
        background: resolve(root, "src/background/index.ts"),
        content: resolve(root, "src/content/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
