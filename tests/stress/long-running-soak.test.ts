import { describe, expect, it } from "vitest";
import { StreamManager } from "../../src/stream/stream-manager";
import type { RenderConfig } from "../../src/canvas/render-types";
import type { StreamPipelinePort, TrackInfo } from "../../src/stream/stream-types";
import { CameraIntegrationHandoff } from "../../src/camera-integration/handoff";
import type { CameraIntegrationAgent } from "../../src/camera-integration/agent";
import type { CameraIntegrationStatus, TargetLifecycleEvent, Unsubscribe } from "../../src/camera-integration/types";
import { RuntimeManager } from "../../src/offscreen/runtime-manager";
import type { MediaRuntime } from "../../src/offscreen/media-runtime";

const CONFIG: RenderConfig = {
  width: 1280,
  height: 720,
  fps: 30,
  fitMode: "contain",
  mirror: false,
};

class FakePipeline implements StreamPipelinePort {
  sourceMediaId: string;
  config: RenderConfig = { ...CONFIG };
  rendering = false;
  disposed = false;
  activeTracks = 1;

  constructor(public mediaId: string) {
    this.sourceMediaId = mediaId;
  }

  getCanvas(): HTMLCanvasElement {
    return {} as HTMLCanvasElement;
  }

  getStream(): MediaStream {
    return {} as MediaStream;
  }

  getTrack(): MediaStreamTrack {
    return { kind: "video", readyState: this.disposed ? "ended" : "live" } as unknown as MediaStreamTrack;
  }

  getTrackInfo(): TrackInfo {
    return {
      id: "track_fake_video_123",
      kind: "video",
      label: "Fake Canvas Video Track",
      readyState: this.disposed ? "ended" : "live",
      enabled: true,
      muted: false,
      settings: {
        width: this.config.width,
        height: this.config.height,
        aspectRatio: this.config.width / this.config.height,
        frameRate: this.config.fps,
      },
    };
  }

  isRendering(): boolean {
    return this.rendering && !this.disposed;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("STREAM_DISPOSED");
    this.rendering = true;
  }

  async stop(): Promise<void> {
    this.rendering = false;
  }

  async restart(): Promise<void> {
    if (this.disposed) throw new Error("STREAM_DISPOSED");
    this.rendering = true;
  }

  async switchSource(mediaId: string): Promise<void> {
    if (this.disposed) throw new Error("STREAM_DISPOSED");
    this.sourceMediaId = mediaId;
  }

  async dispose(): Promise<void> {
    this.rendering = false;
    this.disposed = true;
    this.activeTracks = 0;
  }
}

class FakeStreamFactory {
  activePipelines: FakePipeline[] = [];

  async create(mediaId: string, _config: RenderConfig, _onError: (error: unknown) => void): Promise<StreamPipelinePort> {
    const pipeline = new FakePipeline(mediaId);
    this.activePipelines.push(pipeline);
    return pipeline;
  }
}

class FakeCameraAgent implements CameraIntegrationAgent {
  active = false;
  currentSource: string | null = null;
  trackRetained = true;
  replacedTrackLive = false;
  listeners = new Set<(value: CameraIntegrationStatus) => void>();

  getStatus(): CameraIntegrationStatus {
    return {
      state: this.active ? "ACTIVE" : "READY",
      origin: "https://meet.example.com",
      supported: true,
      permission: "granted",
      capcamActive: this.active,
      originalTrackAvailable: this.trackRetained,
      activeTrackAvailable: this.replacedTrackLive,
      reason: null,
    };
  }

  async detect(): Promise<CameraIntegrationStatus> {
    return this.getStatus();
  }

  async enable(): Promise<CameraIntegrationStatus> {
    this.active = true;
    this.replacedTrackLive = true;
    this.publish();
    return this.getStatus();
  }

  async disable(): Promise<CameraIntegrationStatus> {
    this.active = false;
    this.replacedTrackLive = false;
    this.publish();
    return this.getStatus();
  }

  async switchSource(mediaId: string): Promise<CameraIntegrationStatus> {
    this.currentSource = mediaId;
    this.publish();
    return this.getStatus();
  }

  async handleTargetLifecycle(_event: TargetLifecycleEvent): Promise<CameraIntegrationStatus> {
    this.active = false;
    this.replacedTrackLive = false;
    return this.getStatus();
  }

  subscribeStatus(listener: (value: CameraIntegrationStatus) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async destroy(): Promise<CameraIntegrationStatus> {
    this.active = false;
    this.replacedTrackLive = false;
    return {
      state: "IDLE",
      origin: null,
      supported: false,
      permission: "unknown",
      capcamActive: false,
      originalTrackAvailable: false,
      activeTrackAvailable: false,
      reason: null,
    };
  }

  publish(): void {
    for (const listener of this.listeners) listener(this.getStatus());
  }
}

describe("Phase 11: Long-running soak and stress test suite", () => {
  describe("1. StreamManager 100x create -> start -> stop -> dispose soak", () => {
    it("completes 100 consecutive stream lifecycles without leaking active pipelines or invalid states", async () => {
      const factory = new FakeStreamFactory();
      const manager = new StreamManager(factory);

      for (let i = 0; i < 100; i += 1) {
        const mediaId = `med_soak_${i % 5}`;
        const created = await manager.create({ mediaId, config: CONFIG });
        expect(created.state).toBe("READY");
        expect(manager.getActiveCount()).toBe(1);

        const started = await manager.start({ streamId: created.streamId! });
        expect(started.state).toBe("ACTIVE");
        expect(manager.isRendererActive()).toBe(true);

        const stopped = await manager.stop({ streamId: created.streamId! });
        expect(stopped.state).toBe("STOPPED");
        expect(manager.isRendererActive()).toBe(false);

        const disposed = await manager.dispose({ streamId: created.streamId! });
        expect(disposed.disposed).toBe(true);
        expect(manager.getActiveCount()).toBe(0);
      }

      expect(factory.activePipelines.length).toBe(100);
      expect(factory.activePipelines.every((p) => p.disposed)).toBe(true);
      expect(factory.activePipelines.every((p) => p.activeTracks === 0)).toBe(true);
    });
  });

  describe("2. StreamManager 100x source switch soak", () => {
    it("switches media source 100 times without dropping stream state or creating duplicate loops", async () => {
      const factory = new FakeStreamFactory();
      const manager = new StreamManager(factory);
      const stream = await manager.create({ mediaId: "med_initial", config: CONFIG });
      await manager.start({ streamId: stream.streamId! });

      for (let i = 0; i < 100; i += 1) {
        const targetMediaId = `med_switch_${i % 10}`;
        const updated = await manager.switchSource({
          streamId: stream.streamId!,
          mediaId: targetMediaId,
        });
        expect(updated.sourceMediaId).toBe(targetMediaId);
        expect(updated.state).toBe("ACTIVE");
        expect(manager.isRendererActive()).toBe(true);
      }

      await manager.dispose({ streamId: stream.streamId! });
      expect(manager.getActiveCount()).toBe(0);
    });
  });

  describe("3. CameraIntegration 100x activate -> restore soak", () => {
    it("executes 100 camera replacement & restoration cycles with exact track safety invariants", async () => {
      const agent = new FakeCameraAgent();
      const handoff = new CameraIntegrationHandoff(() => true);
      await handoff.connect(agent);

      for (let i = 0; i < 100; i += 1) {
        const enabled = await handoff.enable();
        expect(enabled.capcamActive).toBe(true);
        expect(agent.trackRetained).toBe(true);
        expect(agent.replacedTrackLive).toBe(true);

        const disabled = await handoff.disable();
        expect(disabled.capcamActive).toBe(false);
        expect(agent.trackRetained).toBe(true);
        expect(agent.replacedTrackLive).toBe(false);
      }
    });
  });

  describe("4. Offscreen RuntimeManager 50x reset/restart soak", () => {
    it("completes 50 resets with unique session IDs and zero residual subsystem state", async () => {
      let shutdownCount = 0;
      let initCount = 0;
      const fakeRuntime: MediaRuntime = {
        mediaEngine: { list: () => [] },
        playback: { getState: () => null, getActiveCount: () => 0 },
        streams: { getActiveCount: () => 0, isRendererActive: () => false },
        async initialize(): Promise<void> { initCount += 1; },
        async shutdown(): Promise<void> { shutdownCount += 1; },
      } as unknown as MediaRuntime;

      let seq = 0;
      const manager = new RuntimeManager(fakeRuntime, {
        createRuntimeSessionId: () => `session_${++seq}`,
      });

      await manager.initialize();
      const sessionIds = new Set<string>();

      for (let i = 0; i < 50; i += 1) {
        const resetSnapshot = await manager.reset();
        expect(resetSnapshot.state).toBe("ready");
        expect(sessionIds.has(resetSnapshot.runtimeSessionId)).toBe(false);
        sessionIds.add(resetSnapshot.runtimeSessionId);
      }

      expect(initCount).toBe(51); // 1 initial + 50 in reset
      expect(shutdownCount).toBe(50); // 50 in reset
      expect(sessionIds.size).toBe(50);
    });
  });

  describe("5. Concurrency & rapid race stress tests", () => {
    it("handles interleaved rapid start/stop commands deterministically", async () => {
      const factory = new FakeStreamFactory();
      const manager = new StreamManager(factory);
      const stream = await manager.create({ mediaId: "med_stress", config: CONFIG });
      const streamId = stream.streamId!;

      // Interleave multiple commands in rapid succession
      const p1 = manager.start({ streamId });
      const p2 = manager.stop({ streamId });
      const p3 = manager.start({ streamId });
      const p4 = manager.stop({ streamId });

      const finalState = await Promise.all([p1, p2, p3, p4]).then((results) => results[results.length - 1]);
      expect(finalState?.state).toBe("STOPPED");
      expect(manager.isRendererActive()).toBe(false);
      await manager.dispose({ streamId });
    });
  });
});
