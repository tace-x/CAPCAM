import type { MediaKind } from "./media-types";

export interface MediaSource {
  readonly id: string;
  readonly kind: MediaKind;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sourceUrl: string;
  release(): Promise<void>;
}

abstract class BaseMediaSource implements MediaSource {
  private releaseTask: Promise<void> | null = null;

  protected constructor(
    readonly id: string,
    readonly name: string,
    readonly mimeType: string,
    readonly size: number,
    readonly sourceUrl: string,
    private readonly releaseResource: () => Promise<void>,
  ) {}

  abstract readonly kind: MediaKind;

  release(): Promise<void> {
    if (this.releaseTask !== null) return this.releaseTask;
    this.releaseTask = Promise.resolve().then(this.releaseResource).catch((error: unknown) => {
      this.releaseTask = null;
      throw error;
    });
    return this.releaseTask;
  }
}

export class ImageMediaSource extends BaseMediaSource {
  readonly kind = "image" as const;

  constructor(
    id: string,
    name: string,
    mimeType: string,
    size: number,
    sourceUrl: string,
    releaseResource: () => Promise<void>,
  ) {
    super(id, name, mimeType, size, sourceUrl, releaseResource);
  }
}

export class VideoMediaSource extends BaseMediaSource {
  readonly kind = "video" as const;

  constructor(
    id: string,
    name: string,
    mimeType: string,
    size: number,
    sourceUrl: string,
    releaseResource: () => Promise<void>,
  ) {
    super(id, name, mimeType, size, sourceUrl, releaseResource);
  }
}
