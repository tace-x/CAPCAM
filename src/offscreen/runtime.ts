import type { RuntimeDiagnostics, RuntimePingResponse, RuntimeStateSnapshot } from "../shared/runtime-types";
import type { OffscreenRuntimeInfo } from "../shared/types";
import { MediaRuntime } from "./media-runtime";
import { RuntimeManager, type RuntimeManagerOptions } from "./runtime-manager";

/** Compatibility facade for callers that still need the coarse offscreen status shape. */
export class OffscreenRuntime {
  readonly manager: RuntimeManager;

  constructor(mediaRuntime: MediaRuntime, options: RuntimeManagerOptions = {}) {
    this.manager = new RuntimeManager(mediaRuntime, options);
  }

  async initialize(): Promise<OffscreenRuntimeInfo> {
    await this.manager.initialize();
    return this.getStatus();
  }

  getStatus(): OffscreenRuntimeInfo {
    return this.manager.getOffscreenStatus();
  }

  async shutdown(): Promise<OffscreenRuntimeInfo> {
    await this.manager.shutdown();
    return this.getStatus();
  }

  async reset(): Promise<RuntimeStateSnapshot> {
    return this.manager.reset();
  }

  getState(): RuntimeStateSnapshot {
    return this.manager.getState();
  }

  getDiagnostics(): RuntimeDiagnostics {
    return this.manager.getDiagnostics();
  }

  ping(): RuntimePingResponse {
    return this.manager.ping();
  }
}
