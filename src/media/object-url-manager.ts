import { MediaEngineError } from "./media-errors";

export interface ObjectUrlApi {
  createObjectURL(object: Blob): string;
  revokeObjectURL(url: string): void;
}

export class ObjectUrlManager {
  private readonly urls = new Set<string>();

  constructor(private readonly urlApi: ObjectUrlApi = URL) {}

  create(blob: Blob): string {
    try {
      const url = this.urlApi.createObjectURL(blob);
      this.track(url);
      return url;
    } catch (error) {
      throw new MediaEngineError("MEDIA_RESOURCE_FAILED", "CapCam could not create a local media URL.", {
        reason: error instanceof Error ? error.message : "Unknown object URL failure.",
      });
    }
  }

  track(url: string): void {
    if (typeof url !== "string" || !url.startsWith("blob:")) {
      throw new MediaEngineError("MEDIA_RESOURCE_FAILED", "Only browser-created Blob URLs can be tracked.");
    }
    this.urls.add(url);
  }

  revoke(url: string): boolean {
    if (!this.urls.has(url)) return false;
    this.urls.delete(url);
    try {
      this.urlApi.revokeObjectURL(url);
      return true;
    } catch (error) {
      throw new MediaEngineError("MEDIA_RESOURCE_FAILED", "CapCam could not revoke a local media URL.", {
        reason: error instanceof Error ? error.message : "Unknown object URL revocation failure.",
      });
    }
  }

  revokeAll(): number {
    const tracked = Array.from(this.urls);
    let firstError: unknown;
    for (const url of tracked) {
      try {
        this.revoke(url);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
    return tracked.length;
  }

  isTracked(url: string): boolean {
    return this.urls.has(url);
  }

  get size(): number {
    return this.urls.size;
  }
}
