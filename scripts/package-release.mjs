import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const releaseDir = resolve(root, "release");

async function packageRelease() {
  console.log("==================================================");
  console.log(" CAPCAM — RELEASE PACKAGING");
  console.log("==================================================");

  // 1. Read metadata
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const version = pkg.version;
  const zipFileName = `capcam-v${version}.zip`;
  const zipFilePath = resolve(releaseDir, zipFileName);

  // 2. Build production bundle
  console.log("\n[1/4] Building production extension...");
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });

  // 3. Verify build
  console.log("\n[2/4] Verifying production artifacts...");
  execFileSync("node", ["scripts/verify-release.mjs"], { cwd: root, stdio: "inherit" });

  // 4. Prepare release folder
  console.log("\n[3/4] Packaging extension archive...");
  await mkdir(releaseDir, { recursive: true });
  await rm(zipFilePath, { force: true });

  // Create ZIP using system zip tool
  execFileSync("zip", ["-r", "-q", zipFilePath, "."], { cwd: dist, stdio: "inherit" });

  // 5. Compute artifact checksum and size
  const zipBuffer = await readFile(zipFilePath);
  const hash = createHash("sha256").update(zipBuffer).digest("hex");
  const stats = await stat(zipFilePath);
  const sizeKb = (stats.size / 1024).toFixed(2);

  console.log("\n[4/4] Release package created successfully:");
  console.log("--------------------------------------------------");
  console.log(` Artifact: release/${zipFileName}`);
  console.log(` Size:     ${sizeKb} KB (${stats.size} bytes)`);
  console.log(` SHA-256:  ${hash}`);
  console.log("--------------------------------------------------");
  console.log("Ready for developer testing via Chrome -> Load Unpacked (dist/) or ZIP distribution.");
}

packageRelease().catch((error) => {
  console.error(`\n❌ [CapCam] Packaging failed: ${error.message}`);
  process.exit(1);
});
