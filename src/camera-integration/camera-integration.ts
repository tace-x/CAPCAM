import { PHASE_06_VERIFIED } from "../config/capabilities";
import { CameraIntegrationCore } from "./camera-integration-core";
import type { CameraIntegrationDependencies } from "./camera-integration-core";

export type { CameraIntegrationDependencies, CameraSource } from "./camera-integration-core";

/** Production coordinator: callers cannot supply or override the Phase 06 evidence gate. */
export class CameraIntegration extends CameraIntegrationCore {
  constructor(dependencies: CameraIntegrationDependencies) {
    super(dependencies, () => PHASE_06_VERIFIED);
  }
}

/** Production factory: activation remains impossible until PHASE_06_VERIFIED is true. */
export function createProductionCameraIntegration(
  dependencies: CameraIntegrationDependencies,
): CameraIntegration {
  return new CameraIntegration(dependencies);
}
