import { StreamEngineError } from "./stream-errors";

export type CanvasCaptureFunction = (canvas: HTMLCanvasElement, fps: number) => MediaStream;

export interface StreamFactoryPort {
  createFromCanvas(canvas: HTMLCanvasElement, fps: number): MediaStream;
}

function nativeCaptureStream(canvas: HTMLCanvasElement, fps: number): MediaStream {
  if (typeof canvas.captureStream !== "function") {
    throw new StreamEngineError("STREAM_CAPTURE_FAILED", "HTMLCanvasElement.captureStream() is unavailable in this Chrome context.");
  }
  return canvas.captureStream(fps);
}

export function stopMediaStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Continue stopping all remaining tracks if one browser track has already ended.
    }
  }
}

export class StreamFactory implements StreamFactoryPort {
  constructor(private readonly capture: CanvasCaptureFunction = nativeCaptureStream) {}

  createFromCanvas(canvas: HTMLCanvasElement, fps: number): MediaStream {
    if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
      throw new StreamEngineError("STREAM_INVALID_CONFIG", "Canvas must have positive dimensions before capture.", {
        width: canvas.width,
        height: canvas.height,
      });
    }
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
      throw new StreamEngineError("STREAM_INVALID_CONFIG", "Canvas capture FPS must be an integer between 1 and 60.", { fps });
    }

    let stream: MediaStream;
    try {
      stream = this.capture(canvas, fps);
    } catch (error) {
      if (error instanceof StreamEngineError) throw error;
      throw new StreamEngineError("STREAM_CAPTURE_FAILED", undefined, {
        reason: error instanceof Error ? error.message : "canvas.captureStream() failed.",
      });
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      stopMediaStreamTracks(stream);
      throw new StreamEngineError("STREAM_NO_VIDEO_TRACK");
    }
    if (videoTracks.length !== 1 || stream.getTracks().length !== 1) {
      stopMediaStreamTracks(stream);
      throw new StreamEngineError("STREAM_CAPTURE_FAILED", "The canvas capture returned an unexpected number or kind of tracks.", {
        videoTrackCount: videoTracks.length,
        totalTrackCount: stream.getTracks().length,
      });
    }
    return stream;
  }
}
