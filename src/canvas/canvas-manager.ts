import { StreamEngineError } from "../stream/stream-errors";
import { validateRenderConfig } from "../stream/stream-types";
import type { RenderConfig } from "./render-types";

export interface CanvasSurface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

export interface CanvasManagerPort {
  create(config: RenderConfig): CanvasSurface;
  getSurface(): CanvasSurface;
  resize(width: number, height: number): void;
  clear(color?: string): void;
  dispose(): void;
}

export type CanvasFactory = () => HTMLCanvasElement;

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 3840 || height < 1 || height > 2160) {
    throw new StreamEngineError("STREAM_INVALID_CONFIG", "Canvas dimensions must be positive integers within the supported output bounds.", {
      width,
      height,
    });
  }
}

export class CanvasManager implements CanvasManagerPort {
  private surface: CanvasSurface | null = null;
  private disposed = false;

  constructor(private readonly createCanvas: CanvasFactory = () => document.createElement("canvas")) {}

  create(config: RenderConfig): CanvasSurface {
    if (this.disposed) throw new StreamEngineError("STREAM_DISPOSED", "A disposed canvas manager cannot be reused.");
    if (this.surface !== null) throw new StreamEngineError("CANVAS_INITIALIZATION_FAILED", "This canvas manager already owns a canvas.");
    const validConfig = validateRenderConfig(config);
    try {
      const canvas = this.createCanvas();
      canvas.width = validConfig.width;
      canvas.height = validConfig.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (context === null) throw new StreamEngineError("CANVAS_CONTEXT_FAILED");
      this.surface = { canvas, context };
      this.clear();
      return this.getSurface();
    } catch (error) {
      this.surface = null;
      if (error instanceof StreamEngineError) throw error;
      throw new StreamEngineError("CANVAS_INITIALIZATION_FAILED", undefined, {
        reason: error instanceof Error ? error.message : "Unknown canvas creation failure.",
      });
    }
  }

  getSurface(): CanvasSurface {
    if (this.disposed) throw new StreamEngineError("STREAM_DISPOSED", "The canvas has been disposed.");
    if (this.surface === null) throw new StreamEngineError("STREAM_NOT_READY", "Canvas has not been created.");
    return this.surface;
  }

  resize(width: number, height: number): void {
    if (this.disposed) throw new StreamEngineError("STREAM_DISPOSED", "The canvas has been disposed.");
    validateDimensions(width, height);
    const surface = this.getSurface();
    if (surface.canvas.width === width && surface.canvas.height === height) return;
    surface.canvas.width = width;
    surface.canvas.height = height;
    this.clear();
  }

  clear(color = "#000000"): void {
    if (this.disposed) throw new StreamEngineError("STREAM_DISPOSED", "The canvas has been disposed.");
    if (this.surface === null) return;
    const { canvas, context } = this.surface;
    context.save();
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
    } finally {
      context.restore();
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    const surface = this.surface;
    this.surface = null;
    this.disposed = true;
    if (surface !== null) {
      surface.canvas.width = 0;
      surface.canvas.height = 0;
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}
