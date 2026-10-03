import { CanvasManager, type CanvasManagerPort } from "../canvas/canvas-manager";
import { CanvasRenderer } from "../canvas/canvas-renderer";
import { FrameScheduler, type FrameSchedulerPort } from "../canvas/frame-scheduler";
import type { RenderConfig, RenderableMediaSource } from "../canvas/render-types";
import { StreamEngineError, toStreamEngineError } from "./stream-errors";
import { StreamFactory, stopMediaStreamTracks, type StreamFactoryPort } from "./stream-factory";
import { TrackInspector } from "./track-inspector";
import type { StreamMediaSourceProvider, StreamPipelineFactory, StreamPipelinePort } from "./stream-types";
import type { TrackInfo } from "./stream-types";

export interface CanvasStreamPipelineDependencies {
  createCanvasManager?: () => CanvasManagerPort;
  streamFactory?: StreamFactoryPort;
  createScheduler?: (render: () => void, fps: number, onError: (error: unknown) => void) => FrameSchedulerPort;
  trackInspector?: TrackInspector;
}

export class CanvasStreamPipeline implements StreamPipelinePort {
  private source: RenderableMediaSource | null;
  private currentSourceMediaId: string;
  private stream: MediaStream | null;
  private disposed = false;

  private constructor(
    source: RenderableMediaSource,
    private readonly renderConfig: RenderConfig,
    private readonly canvasManager: CanvasManagerPort,
    private readonly renderer: CanvasRenderer,
    private readonly streamFactory: StreamFactoryPort,
    private readonly scheduler: FrameSchedulerPort,
    private readonly sourceProvider: StreamMediaSourceProvider,
    private readonly inspector: TrackInspector,
    private readonly onError: (error: unknown) => void,
    stream: MediaStream,
  ) {
    this.source = source;
    this.currentSourceMediaId = source.mediaId;
    this.stream = stream;
  }

  get sourceMediaId(): string {
    return this.currentSourceMediaId;
  }

  get config(): RenderConfig {
    return { ...this.renderConfig };
  }

  static async create(
    mediaId: string,
    config: RenderConfig,
    sourceProvider: StreamMediaSourceProvider,
    onError: (error: unknown) => void,
    dependencies: CanvasStreamPipelineDependencies = {},
  ): Promise<CanvasStreamPipeline> {
    const canvasManager = dependencies.createCanvasManager?.() ?? new CanvasManager();
    const streamFactory = dependencies.streamFactory ?? new StreamFactory();
    const inspector = dependencies.trackInspector ?? new TrackInspector();
    let renderer: CanvasRenderer | null = null;
    let stream: MediaStream | null = null;

    try {
      const source = sourceProvider.getRenderableSource(mediaId);
      const surface = canvasManager.create(config);
      renderer = new CanvasRenderer(canvasManager, config);
      renderer.setSource(source);
      // Paint an image immediately. A video with metadata but no decoded frame remains black until playback.
      renderer.render();
      stream = streamFactory.createFromCanvas(surface.canvas, config.fps);
      const schedulerFactory = dependencies.createScheduler ?? ((render, fps, onFrameError) =>
        new FrameScheduler(render, fps, onFrameError));
      let pipeline: CanvasStreamPipeline | null = null;
      const scheduler = schedulerFactory(
        () => {
          if (renderer === null) throw new StreamEngineError("STREAM_DISPOSED");
          renderer.render();
        },
        config.fps,
        (error) => {
          pipeline?.handleFrameError(error);
          if (pipeline === null) onError(error);
        },
      );
      pipeline = new CanvasStreamPipeline(
        source,
        { ...config },
        canvasManager,
        renderer,
        streamFactory,
        scheduler,
        sourceProvider,
        inspector,
        onError,
        stream,
      );
      return pipeline;
    } catch (error) {
      if (stream !== null) stopMediaStreamTracks(stream);
      renderer?.dispose();
      canvasManager.dispose();
      throw toStreamEngineError(error, "STREAM_INITIALIZATION_FAILED");
    }
  }

  getCanvas(): HTMLCanvasElement {
    this.assertActive();
    return this.canvasManager.getSurface().canvas;
  }

  getStream(): MediaStream {
    this.assertActive();
    if (this.stream === null) throw new StreamEngineError("STREAM_NOT_READY");
    return this.stream;
  }

  getTrack(): MediaStreamTrack {
    const track = this.getStream().getVideoTracks()[0];
    if (track === undefined || track.kind !== "video") throw new StreamEngineError("STREAM_NO_VIDEO_TRACK");
    return track;
  }

  getTrackInfo(): TrackInfo {
    const info = this.inspector.inspect(this.getTrack());
    if (info === null) throw new StreamEngineError("STREAM_NO_VIDEO_TRACK");
    return info;
  }

  isRendering(): boolean {
    return !this.disposed && this.scheduler.isRunning();
  }

  async start(): Promise<void> {
    this.assertActive();
    if (this.scheduler.isRunning()) throw new StreamEngineError("STREAM_ALREADY_ACTIVE");
    if (this.getTrack().readyState !== "live") {
      throw new StreamEngineError("STREAM_NOT_READY", "The stopped capture track must be recreated before starting.");
    }
    try {
      this.scheduler.start();
    } catch (error) {
      stopMediaStreamTracks(this.requireStream());
      throw toStreamEngineError(error, "FRAME_SCHEDULER_FAILED");
    }
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.scheduler.stop();
    if (this.stream !== null) stopMediaStreamTracks(this.stream);
  }

  async restart(): Promise<void> {
    this.assertActive();
    await this.stop();
    const canvas = this.canvasManager.getSurface().canvas;
    const nextStream = this.streamFactory.createFromCanvas(canvas, this.renderConfig.fps);
    this.stream = nextStream;
    try {
      await this.start();
    } catch (error) {
      stopMediaStreamTracks(nextStream);
      throw error;
    }
  }

  async switchSource(mediaId: string): Promise<void> {
    this.assertActive();
    const previous = this.requireSource();
    if (previous.mediaId === mediaId) return;
    const next = this.sourceProvider.getRenderableSource(mediaId);
    try {
      this.renderer.setSource(next);
      this.renderer.render();
      this.source = next;
      this.currentSourceMediaId = next.mediaId;
    } catch (error) {
      this.renderer.setSource(previous);
      this.renderer.render();
      throw toStreamEngineError(error, "STREAM_SOURCE_UNAVAILABLE");
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    let cleanupFailure: unknown;
    try {
      await this.stop();
    } catch (error) {
      cleanupFailure = error;
    } finally {
      this.scheduler.dispose();
      this.renderer.dispose();
      this.canvasManager.dispose();
      this.stream = null;
      this.source = null;
      this.disposed = true;
    }
    if (cleanupFailure !== undefined) throw toStreamEngineError(cleanupFailure, "STREAM_RENDER_FAILED");
  }

  private handleFrameError(error: unknown): void {
    void this.stop().catch(() => undefined);
    this.onError(toStreamEngineError(error, "STREAM_RENDER_FAILED"));
  }

  private requireSource(): RenderableMediaSource {
    if (this.source === null) throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE");
    return this.source;
  }

  private requireStream(): MediaStream {
    if (this.stream === null) throw new StreamEngineError("STREAM_DISPOSED");
    return this.stream;
  }

  private assertActive(): void {
    if (this.disposed) throw new StreamEngineError("STREAM_DISPOSED");
  }
}

export class CanvasStreamPipelineFactory implements StreamPipelineFactory {
  constructor(
    private readonly sourceProvider: StreamMediaSourceProvider,
    private readonly dependencies: CanvasStreamPipelineDependencies = {},
  ) {}

  create(mediaId: string, config: RenderConfig, onError: (error: unknown) => void): Promise<StreamPipelinePort> {
    return CanvasStreamPipeline.create(mediaId, config, this.sourceProvider, onError, this.dependencies);
  }
}
