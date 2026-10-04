import { StreamEngineError } from "../stream/stream-errors";
import { validateRenderConfig } from "../stream/stream-types";
import { calculateRenderTransform } from "./render-transform";
import type { CanvasManagerPort } from "./canvas-manager";
import type { RenderConfig, RenderableMediaSource } from "./render-types";

export class CanvasRenderer {
  private source: RenderableMediaSource | null = null;
  private config: RenderConfig;
  private disposed = false;

  constructor(private readonly canvasManager: CanvasManagerPort, config: RenderConfig) {
    this.config = validateRenderConfig(config);
  }

  setSource(source: RenderableMediaSource): void {
    this.assertActive();
    if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) {
      throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "Renderable source dimensions are invalid.", { mediaId: source.mediaId });
    }
    this.source = source;
  }

  setConfig(config: RenderConfig): void {
    this.assertActive();
    const next = validateRenderConfig(config);
    this.canvasManager.resize(next.width, next.height);
    this.config = next;
  }

  renderImage(source: CanvasImageSource): boolean {
    if (this.source?.kind !== "image" || this.source.element !== source) {
      throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "The image does not belong to the current render source.");
    }
    return this.render();
  }

  renderVideo(source: HTMLVideoElement): boolean {
    if (this.source?.kind !== "video" || this.source.element !== source) {
      throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "The video does not belong to the current render source.");
    }
    return this.render();
  }

  render(): boolean {
    this.assertActive();
    const source = this.source;
    if (source === null) throw new StreamEngineError("STREAM_SOURCE_UNAVAILABLE", "No media source is set on the canvas renderer.");

    let sourceWidth = source.width;
    let sourceHeight = source.height;
    if (source.kind === "image") {
      const img = source.element;
      if ("complete" in img && "naturalWidth" in img) {
        const htmlImg = img as HTMLImageElement;
        if (!htmlImg.complete || htmlImg.naturalWidth <= 0 || htmlImg.naturalHeight <= 0) return false;
        sourceWidth = htmlImg.naturalWidth;
        sourceHeight = htmlImg.naturalHeight;
      } else if ("width" in img && "height" in img) {
        const bitmap = img as ImageBitmap;
        if (bitmap.width <= 0 || bitmap.height <= 0) return false;
        sourceWidth = bitmap.width;
        sourceHeight = bitmap.height;
      }
    } else {
      const video = source.element;
      if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return false;
      sourceWidth = video.videoWidth;
      sourceHeight = video.videoHeight;
    }

    const surface = this.canvasManager.getSurface();
    const transform = calculateRenderTransform(
      sourceWidth,
      sourceHeight,
      this.config.width,
      this.config.height,
      this.config.fitMode,
    );
    this.canvasManager.clear("#000000");
    surface.context.save();
    try {
      surface.context.setTransform(1, 0, 0, 1, 0, 0);
      if (this.config.mirror) {
        surface.context.translate(surface.canvas.width, 0);
        surface.context.scale(-1, 1);
      }
      surface.context.drawImage(
        source.element,
        transform.sourceX,
        transform.sourceY,
        transform.sourceWidth,
        transform.sourceHeight,
        transform.x,
        transform.y,
        transform.width,
        transform.height,
      );
      return true;
    } catch (error) {
      throw new StreamEngineError("STREAM_RENDER_FAILED", undefined, {
        mediaId: source.mediaId,
        reason: error instanceof Error ? error.message : "Canvas drawImage failed.",
      });
    } finally {
      surface.context.restore();
      surface.context.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  clear(): void {
    this.assertActive();
    this.canvasManager.clear("#000000");
  }

  dispose(): void {
    if (this.disposed) return;
    this.source = null;
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) throw new StreamEngineError("STREAM_DISPOSED", "The canvas renderer has been disposed.");
  }
}
