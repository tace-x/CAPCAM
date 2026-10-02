import { MediaEngineError } from "./media-errors";
import type { ImageResourceInfo } from "./media-types";

export interface ImageElementLike {
  src: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  decode?: () => Promise<void>;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  removeAttribute(name: string): void;
}

export interface ImageResourceManagerPort {
  load(mediaId: string, sourceUrl: string, signal: AbortSignal, timeoutMs?: number): Promise<ImageResourceInfo>;
  releaseImage(mediaId: string): Promise<void>;
  hasImage(mediaId: string): boolean;
}

function abortError(): MediaEngineError {
  return new MediaEngineError("MEDIA_CANCELLED");
}

function imageFailure(error: unknown): MediaEngineError {
  if (error instanceof MediaEngineError) return error;
  return new MediaEngineError("MEDIA_DECODE_FAILED", undefined, {
    reason: error instanceof Error ? error.message : "Image decoder rejected the file.",
  });
}

export class ImageResourceManager implements ImageResourceManagerPort {
  private readonly images = new Map<string, ImageElementLike>();

  constructor(
    private readonly createImage: () => ImageElementLike = () => new Image(),
    private readonly defaultTimeoutMs = 15_000,
  ) {}

  async load(
    mediaId: string,
    sourceUrl: string,
    signal: AbortSignal,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<ImageResourceInfo> {
    if (this.images.has(mediaId)) {
      throw new MediaEngineError("MEDIA_INVALID_STATE", "An image resource already exists for this media ID.", { mediaId });
    }
    if (signal.aborted) throw abortError();

    const image = this.createImage();
    this.images.set(mediaId, image);
    try {
      await this.waitForDecode(image, sourceUrl, signal, timeoutMs);
      if (signal.aborted) throw abortError();
      if (!Number.isInteger(image.naturalWidth) || !Number.isInteger(image.naturalHeight) || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        throw new MediaEngineError("MEDIA_METADATA_FAILED", undefined, { mediaId });
      }
      return { width: image.naturalWidth, height: image.naturalHeight };
    } catch (error) {
      await this.releaseImage(mediaId);
      throw imageFailure(error);
    }
  }

  async releaseImage(mediaId: string): Promise<void> {
    const image = this.images.get(mediaId);
    if (image === undefined) return;
    this.images.delete(mediaId);
    try {
      image.removeAttribute("src");
    } catch (error) {
      throw new MediaEngineError("MEDIA_RESOURCE_FAILED", "CapCam could not release the decoded image.", {
        reason: error instanceof Error ? error.message : "Unknown image release failure.",
      });
    }
  }

  hasImage(mediaId: string): boolean {
    return this.images.has(mediaId);
  }

  private waitForDecode(image: ImageElementLike, sourceUrl: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hasAsyncDecode = typeof image.decode === "function";

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
      };
      const finish = (error?: MediaEngineError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => finish(abortError());
      const onLoad = (): void => {
        if (!hasAsyncDecode) finish();
      };
      const onError = (): void => finish(new MediaEngineError("MEDIA_DECODE_FAILED"));

      if (signal.aborted) {
        finish(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      timer = setTimeout(() => finish(new MediaEngineError("MEDIA_LOAD_TIMEOUT")), timeoutMs);

      try {
        image.src = sourceUrl;
        if (typeof image.decode === "function") {
          void image.decode().then(() => finish(), (error: unknown) => finish(imageFailure(error)));
        } else if (image.complete && image.naturalWidth > 0) {
          finish();
        }
      } catch (error) {
        finish(imageFailure(error));
      }
    });
  }
}
