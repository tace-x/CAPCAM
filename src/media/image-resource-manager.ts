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
  getImageElement?(mediaId: string): ImageElementLike | undefined;
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

/** Dimensions resolved by whichever decode strategy succeeds first. */
interface DecodeResult {
  width: number;
  height: number;
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
      const result = await this.waitForDecode(image, sourceUrl, signal, timeoutMs);
      if (signal.aborted) throw abortError();
      if (!Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width <= 0 || result.height <= 0) {
        throw new MediaEngineError("MEDIA_METADATA_FAILED", undefined, { mediaId });
      }
      return { width: result.width, height: result.height };
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

  getImageElement(mediaId: string): ImageElementLike | undefined {
    return this.images.get(mediaId);
  }

  private waitForDecode(image: ImageElementLike, sourceUrl: string, signal: AbortSignal, timeoutMs: number): Promise<DecodeResult> {
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
      const finish = (result?: DecodeResult, error?: MediaEngineError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) reject(error);
        else if (result !== undefined) resolve(result);
        else reject(new MediaEngineError("MEDIA_DECODE_FAILED"));
      };
      const finishFromImage = (): void => {
        finish({ width: image.naturalWidth, height: image.naturalHeight });
      };
      const onAbort = (): void => { finish(undefined, abortError()); };
      const onLoad = (): void => {
        if (!hasAsyncDecode) finishFromImage();
      };
      const onError = (): void => { finish(undefined, new MediaEngineError("MEDIA_DECODE_FAILED")); };

      if (signal.aborted) {
        finish(undefined, abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      timer = setTimeout(() => finish(undefined, new MediaEngineError("MEDIA_LOAD_TIMEOUT")), timeoutMs);

      try {
        image.src = sourceUrl;

        // Primary decode path: Image.decode() or load event (works in regular pages)
        if (hasAsyncDecode) {
          void image.decode?.().then(
            () => finishFromImage(),
            (error: unknown) => finish(undefined, imageFailure(error)),
          );
        } else if (image.complete && image.naturalWidth > 0) {
          finishFromImage();
        }

        // Parallel fallback: createImageBitmap works reliably in offscreen documents
        // where Image.decode() and load events may silently hang because the offscreen
        // document has no visible rendering pipeline. This races against the primary
        // path — whichever resolves first wins via the `settled` guard.
        if (typeof createImageBitmap === "function" && sourceUrl.startsWith("blob:")) {
          void fetch(sourceUrl)
            .then((response) => response.blob())
            .then((blob) => createImageBitmap(blob))
            .then((bitmap) => {
              const w = bitmap.width;
              const h = bitmap.height;
              bitmap.close();
              finish({ width: w, height: h });
            })
            .catch(() => {
              // If createImageBitmap also fails, the primary path timeout will handle it.
            });
        }
      } catch (error) {
        finish(undefined, imageFailure(error));
      }
    });
  }
}
