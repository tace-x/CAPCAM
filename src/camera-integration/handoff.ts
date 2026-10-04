import { PHASE_06_VERIFIED } from "../config/capabilities";
import type { CameraIntegrationAgent } from "./agent";
import { normalizeWebOrigin } from "./origin";
import { isCameraIntegrationStatus, type CameraIntegrationStatus, type TargetLifecycleEvent, type Unsubscribe } from "./types";

export interface CameraIntegrationStatusUpdate {
  revision: number;
  changedAt: number;
  status: CameraIntegrationStatus;
}

export function isCameraIntegrationStatusUpdate(value: unknown): value is CameraIntegrationStatusUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  return typeof update.revision === "number" && Number.isSafeInteger(update.revision) && update.revision >= 0 &&
    typeof update.changedAt === "number" && Number.isFinite(update.changedAt) &&
    isCameraIntegrationStatus(update.status) && Object.keys(update).length === 3 &&
    Object.keys(update).every((key) => ["revision", "changedAt", "status"].includes(key));
}

export type CameraIntegrationVerification = () => boolean;

function unavailableStatus(verified: boolean): CameraIntegrationStatus {
  return {
    state: verified ? "UNSUPPORTED" : "BLOCKED_PHASE_06_VERIFICATION",
    origin: null,
    supported: false,
    permission: "unavailable",
    capcamActive: false,
    originalTrackAvailable: false,
    activeTrackAvailable: false,
    reason: verified ? "TARGET_CONTEXT_UNAVAILABLE" : "BLOCKED_PHASE_06_VERIFICATION",
  };
}

function copyStatus(status: CameraIntegrationStatus): CameraIntegrationStatus {
  const origin = normalizeWebOrigin(status.origin);
  return { ...status, origin };
}

/**
 * Stable control-plane handoff between extension UI/runtime and a target-context agent.
 * The agent itself—and all streams, tracks and senders—stays in its owning JS realm.
 */
export class CameraIntegrationHandoff {
  private agent: CameraIntegrationAgent | null = null;
  private agentUnsubscribe: Unsubscribe | null = null;
  private current: CameraIntegrationStatus;
  private revision = 0;
  private changedAt: number;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(update: CameraIntegrationStatusUpdate) => void>();

  constructor(
    private readonly phase06Verified: CameraIntegrationVerification = () => PHASE_06_VERIFIED,
    private readonly now: () => number = Date.now,
  ) {
    this.current = unavailableStatus(this.isVerified());
    this.changedAt = this.now();
  }

  getStatus(): CameraIntegrationStatus {
    return copyStatus(this.current);
  }

  getSnapshot(): CameraIntegrationStatusUpdate {
    return { revision: this.revision, changedAt: this.changedAt, status: this.getStatus() };
  }

  subscribe(listener: (update: CameraIntegrationStatusUpdate) => void): Unsubscribe {
    this.listeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch {
      // Observers must not break API registration.
    }
    return () => this.listeners.delete(listener);
  }

  /** A local agent registers over an explicitly authorized in-context handoff. */
  connect(agent: CameraIntegrationAgent): Promise<Unsubscribe> {
    return this.serialize(async () => {
      if (!this.isVerified()) {
        const cleanup = await this.disconnectCurrent("extension-restart");
        if (cleanup?.state !== "ERROR") this.publish(unavailableStatus(false));
        return () => undefined;
      }
      if (this.agent === agent) return () => { void this.disconnect(agent, "extension-restart"); };
      const cleanup = await this.disconnectCurrent("extension-restart");
      if (cleanup?.state === "ERROR") return () => undefined;
      const generation = ++this.generation;
      this.agent = agent;
      try {
        this.agentUnsubscribe = agent.subscribeStatus((status) => {
          if (this.agent !== agent || this.generation !== generation) return;
          if (isCameraIntegrationStatus(status)) this.publish(status);
          else this.publish({ ...this.current, state: "ERROR", reason: "INVALID_INTEGRATION_STATUS" });
        });
        const initial = agent.getStatus();
        if (!isCameraIntegrationStatus(initial)) throw new Error("invalid-integration-status");
        this.publish(initial);
      } catch {
        try {
          this.agentUnsubscribe?.();
        } catch {
          // Best-effort detach when the agent fails during registration.
        }
        this.agentUnsubscribe = null;
        this.agent = null;
        this.generation += 1;
        this.publish({ ...this.current, state: "ERROR", reason: "INTEGRATION_HANDOFF_FAILED" });
        return () => undefined;
      }
      return () => { void this.disconnect(agent, "extension-restart"); };
    });
  }

  disconnect(agent: CameraIntegrationAgent, event: TargetLifecycleEvent = "extension-restart"): Promise<CameraIntegrationStatus> {
    return this.serialize(async () => {
      if (this.agent !== agent) return this.getStatus();
      const cleanup = await this.disconnectCurrent(event);
      if (cleanup?.state !== "ERROR") this.publish(unavailableStatus(this.isVerified()));
      return this.getStatus();
    });
  }

  detect(): Promise<CameraIntegrationStatus> {
    return this.invoke((agent) => agent.detect());
  }

  enable(): Promise<CameraIntegrationStatus> {
    return this.invoke((agent) => agent.enable());
  }

  disable(): Promise<CameraIntegrationStatus> {
    // Restoration is always allowed, even if activation verification is no longer open.
    return this.invoke((agent) => agent.disable(), true);
  }

  switchSource(mediaId: string): Promise<CameraIntegrationStatus> {
    return this.invoke((agent) => agent.switchSource(mediaId));
  }

  private invoke(
    action: (agent: CameraIntegrationAgent) => Promise<CameraIntegrationStatus>,
    allowUnverifiedCleanup = false,
  ): Promise<CameraIntegrationStatus> {
    return this.serialize(async () => {
      if (!this.isVerified() && !allowUnverifiedCleanup) {
        const gated = unavailableStatus(false);
        this.publish(gated);
        return gated;
      }
      const agent = this.agent;
      const generation = this.generation;
      if (agent === null) {
        const unavailable: CameraIntegrationStatus = this.current.capcamActive
          ? { ...this.current, state: "ERROR", reason: "INTEGRATION_HANDOFF_UNAVAILABLE" }
          : unavailableStatus(this.isVerified());
        this.publish(unavailable);
        return unavailable;
      }

      try {
        const result = await action(agent);
        if (this.agent !== agent || this.generation !== generation) return this.getStatus();
        if (!isCameraIntegrationStatus(result)) throw new Error("invalid-integration-status");
        this.publish(result);
      } catch {
        if (this.agent === agent && this.generation === generation) {
          let fallback = this.current;
          try {
            fallback = agent.getStatus();
          } catch {
            // Retain the last safe snapshot if the local agent cannot report its state.
          }
          this.publish({
            ...fallback,
            state: "ERROR",
            reason: "INTEGRATION_HANDOFF_FAILED",
          });
        }
      }
      return this.getStatus();
    });
  }

  private async disconnectCurrent(event: TargetLifecycleEvent): Promise<CameraIntegrationStatus | null> {
    const agent = this.agent;
    const unsubscribe = this.agentUnsubscribe;
    this.agent = null;
    this.agentUnsubscribe = null;
    this.generation += 1;
    try {
      unsubscribe?.();
    } catch {
      // Disconnect still proceeds when a status observer cannot detach.
    }
    if (agent === null) return null;
    try {
      await agent.handleTargetLifecycle(event);
    } catch {
      // Best-effort restoration runs before agent cleanup.
    }
    try {
      const result = await agent.destroy();
      this.publish(result);
      if (result.state === "ERROR" && (result.capcamActive || result.reason === "CLEANUP_FAILED" || result.reason === "RESTORE_AND_DETACH_FAILED")) {
        // Retain an explicit recovery handle so the user can retry restoration.
        this.agent = agent;
      }
      return result;
    } catch {
      let status = this.current;
      try {
        status = agent.getStatus();
      } catch {
        // Keep the last safe status snapshot if the agent itself is unavailable.
      }
      const failure: CameraIntegrationStatus = {
        ...status,
        state: "ERROR",
        reason: "INTEGRATION_CLEANUP_FAILED",
      };
      this.agent = agent;
      this.publish(failure);
      return failure;
    }
  }

  private publish(status: CameraIntegrationStatus): void {
    this.current = isCameraIntegrationStatus(status)
      ? copyStatus(status)
      : { ...this.current, state: "ERROR", reason: "INVALID_INTEGRATION_STATUS" };
    this.revision += 1;
    this.changedAt = this.now();
    const update = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        // UI observers cannot interfere with lifecycle or handoff recovery.
      }
    }
  }

  private isVerified(): boolean {
    try {
      return this.phase06Verified();
    } catch {
      return false;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
