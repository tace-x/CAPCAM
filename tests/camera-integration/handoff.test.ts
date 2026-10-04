import { describe, expect, it } from "vitest";
import { CameraIntegrationHandoff } from "../../src/camera-integration/handoff";
import type { CameraIntegrationAgent } from "../../src/camera-integration/agent";
import type { CameraIntegrationStatus, TargetLifecycleEvent, Unsubscribe } from "../../src/camera-integration/types";

const ORIGIN = "https://call.example.test";

function status(state: CameraIntegrationStatus["state"] = "READY"): CameraIntegrationStatus {
  return {
    state,
    origin: ORIGIN,
    supported: true,
    permission: "granted",
    capcamActive: state === "ACTIVE",
    originalTrackAvailable: true,
    activeTrackAvailable: state === "ACTIVE",
    reason: null,
  };
}

class FakeAgent implements CameraIntegrationAgent {
  current = status();
  readonly listeners = new Set<(value: CameraIntegrationStatus) => void>();
  readonly calls: string[] = [];

  getStatus(): CameraIntegrationStatus {
    return { ...this.current };
  }

  async detect(): Promise<CameraIntegrationStatus> {
    this.calls.push("detect");
    this.current = status();
    return this.getStatus();
  }

  async enable(): Promise<CameraIntegrationStatus> {
    this.calls.push("enable");
    this.current = status("ACTIVE");
    this.publish();
    return this.getStatus();
  }

  async disable(): Promise<CameraIntegrationStatus> {
    this.calls.push("disable");
    this.current = status();
    return this.getStatus();
  }

  async switchSource(mediaId: string): Promise<CameraIntegrationStatus> {
    this.calls.push(`switch:${mediaId}`);
    this.current = { ...status("ACTIVE"), reason: null };
    return this.getStatus();
  }

  async handleTargetLifecycle(_event: TargetLifecycleEvent): Promise<CameraIntegrationStatus> {
    this.calls.push("lifecycle");
    this.current = status("BLOCKED");
    return this.getStatus();
  }

  subscribeStatus(listener: (value: CameraIntegrationStatus) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async destroy(): Promise<CameraIntegrationStatus> {
    this.calls.push("destroy");
    this.current = status("IDLE");
    return this.getStatus();
  }

  publish(): void {
    for (const listener of this.listeners) listener(this.getStatus());
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("camera integration control-plane handoff", () => {
  it("keeps production camera commands behind the Phase 06 verification gate", async () => {
    const agent = new FakeAgent();
    const handoff = new CameraIntegrationHandoff(() => false, () => 100);

    await handoff.connect(agent);
    expect(await handoff.enable()).toMatchObject({
      state: "BLOCKED_PHASE_06_VERIFICATION",
      reason: "BLOCKED_PHASE_06_VERIFICATION",
      capcamActive: false,
    });
    expect(agent.calls).toEqual([]);
    expect(handoff.getSnapshot()).toMatchObject({ revision: 2, changedAt: 100 });
  });

  it("still permits restoration after the activation verification gate closes", async () => {
    let verified = true;
    const agent = new FakeAgent();
    const handoff = new CameraIntegrationHandoff(() => verified);
    await handoff.connect(agent);
    await handoff.enable();
    expect(handoff.getStatus().capcamActive).toBe(true);

    verified = false;
    const restored = await handoff.disable();
    expect(agent.calls).toEqual(["enable", "disable"]);
    expect(restored).toMatchObject({ state: "READY", capcamActive: false });
  });

  it("serializes operations and publishes revisioned snapshots with timestamps", async () => {
    const agent = new FakeAgent();
    const releaseEnable = deferred<void>();
    const enableStarted = deferred<void>();
    const order: string[] = [];
    agent.enable = async () => {
      order.push("enable-start");
      enableStarted.resolve();
      await releaseEnable.promise;
      order.push("enable-end");
      agent.current = status("ACTIVE");
      return agent.getStatus();
    };
    agent.disable = async () => {
      order.push("disable");
      agent.current = status();
      return agent.getStatus();
    };
    let clock = 1000;
    const handoff = new CameraIntegrationHandoff(() => true, () => ++clock);
    const observed: number[] = [];
    handoff.subscribe((update) => observed.push(update.revision));
    await handoff.connect(agent);

    const enabling = handoff.enable();
    await enableStarted.promise;
    const disabling = handoff.disable();
    expect(order).toEqual(["enable-start"]);
    releaseEnable.resolve();
    await Promise.all([enabling, disabling]);

    expect(order).toEqual(["enable-start", "enable-end", "disable"]);
    const snapshot = handoff.getSnapshot();
    expect(snapshot.status.state).toBe("READY");
    expect(snapshot.revision).toBeGreaterThan(1);
    expect(snapshot.changedAt).toBeGreaterThan(1000);
    expect(observed).toEqual([...observed].sort((left, right) => left - right));
  });

  it("disconnects and destroys the agent, then ignores late status callbacks", async () => {
    const agent = new FakeAgent();
    const handoff = new CameraIntegrationHandoff(() => true);
    await handoff.connect(agent);
    const lateListener = [...agent.listeners][0];
    expect(lateListener).toBeDefined();

    await handoff.disconnect(agent, "navigation");
    expect(agent.calls).toEqual(["lifecycle", "destroy"]);
    expect(handoff.getStatus()).toMatchObject({
      state: "UNSUPPORTED",
      reason: "TARGET_CONTEXT_UNAVAILABLE",
      capcamActive: false,
    });

    lateListener?.(status("ACTIVE"));
    expect(handoff.getStatus().capcamActive).toBe(false);
  });

  it("retains a recovery agent when cleanup fails so restoration can be retried", async () => {
    const agent = new FakeAgent();
    let destroyAttempts = 0;
    agent.destroy = async () => {
      destroyAttempts += 1;
      agent.calls.push("destroy");
      agent.current = destroyAttempts === 1
        ? { ...status("ERROR"), capcamActive: true, activeTrackAvailable: true, reason: "RESTORE_AND_DETACH_FAILED" }
        : status("IDLE");
      return agent.getStatus();
    };
    const handoff = new CameraIntegrationHandoff(() => true);
    await handoff.connect(agent);
    await handoff.enable();

    const disconnected = await handoff.disconnect(agent, "extension-restart");
    expect(disconnected).toMatchObject({ state: "ERROR", capcamActive: true });
    const recovered = await handoff.disable();

    expect(agent.calls).toEqual(["enable", "lifecycle", "destroy", "disable"]);
    expect(recovered).toMatchObject({ state: "READY", capcamActive: false });
  });

  it("forwards source IDs without moving media objects through the handoff", async () => {
    const agent = new FakeAgent();
    const handoff = new CameraIntegrationHandoff(() => true);
    await handoff.connect(agent);
    const result = await handoff.switchSource("media_example123");

    expect(agent.calls).toContain("switch:media_example123");
    expect(result.capcamActive).toBe(true);
  });
});
