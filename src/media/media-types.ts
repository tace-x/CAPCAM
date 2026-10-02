export type MediaType = "image" | "video";

export interface MediaMetadata {
  mediaId: string;
  name: string;
  type: MediaType;
  mimeType: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
}
