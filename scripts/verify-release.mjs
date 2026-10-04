import { readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function verifyRelease() {
  console.log("[CapCam] Running pre-release verification checks...");

  // 1. Version consistency check
  const pkgRaw = await readFile(resolve(root, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);

  const manifestRaw = await readFile(resolve(root, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);

  if (pkg.version !== manifest.version) {
    throw new Error(`Version mismatch: package.json is ${pkg.version} but manifest.json is ${manifest.version}`);
  }
  console.log(`✓ Version aligned: v${pkg.version}`);

  // 2. Permission security check
  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected Manifest V3, found: ${manifest.manifest_version}`);
  }
  const expectedPermissions = ["storage", "offscreen"];
  if (JSON.stringify(manifest.permissions?.sort()) !== JSON.stringify(expectedPermissions.sort())) {
    throw new Error(`Permissions mismatch: expected ${expectedPermissions.join(", ")}, got ${manifest.permissions?.join(", ")}`);
  }
  if (manifest.host_permissions || manifest.optional_permissions || manifest.optional_host_permissions) {
    throw new Error("Production manifest contains unauthorized host or optional permissions.");
  }
  console.log("✓ Manifest permissions strictly limited to least-privilege ['storage', 'offscreen']");

  // 3. Phase 06 Safety Gate check
  const capabilitiesSrc = await readFile(resolve(root, "src/config/capabilities.ts"), "utf8");
  if (!capabilitiesSrc.includes("PHASE_06_VERIFIED = false")) {
    throw new Error("Safety invariant violated: PHASE_06_VERIFIED must remain false until real Chrome verification.");
  }
  console.log("✓ Safety gate intact (PHASE_06_VERIFIED = false)");

  // 4. Dist build existence and completeness check
  const requiredDistFiles = [
    "manifest.json",
    "background.js",
    "offscreen.js",
    "popup.html",
    "popup.js",
    "public/offscreen.html",
    "icons/icon16.png",
    "icons/icon32.png",
    "icons/icon48.png",
    "icons/icon128.png",
  ];

  for (const file of requiredDistFiles) {
    const fullPath = resolve(dist, file);
    if (!(await fileExists(fullPath))) {
      throw new Error(`Required production build file missing: ${file}`);
    }
  }
  console.log(`✓ All ${requiredDistFiles.length} core production build artifacts verified in dist/`);

  // 5. Contamination check: Ensure camera test suite is NOT in production dist
  if (await fileExists(resolve(dist, "tests"))) {
    throw new Error("Contamination detected: dist/ contains camera-test artifacts (tests/ directory).");
  }
  console.log("✓ Zero camera-test contamination in production dist/");

  console.log("[CapCam] Pre-release verification passed successfully.");
}

verifyRelease().catch((error) => {
  console.error(`\n❌ [CapCam] Release verification failed: ${error.message}`);
  process.exit(1);
});
