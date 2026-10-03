import { cp, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });
await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
await cp(resolve(root, "public/icons"), resolve(dist, "icons"), { recursive: true });
