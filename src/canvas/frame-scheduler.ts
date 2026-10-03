import { StreamEngineError } from "../stream/stream-errors";

export interface FrameClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface FrameSchedulerPort {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  dispose(): void;
}

function browserClock(): FrameClock {
  return {
    now: () => globalThis.performance?.now() ?? Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
}

/** A single drift-corrected timer loop works in both visible test pages and hidden offscreen documents. */
export class FrameScheduler implements FrameSchedulerPort {
  private running = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextFrameAt = 0;
  private readonly frameIntervalMs: number;

  constructor(
    private readonly render: () => void,
    fps: number,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly clock: FrameClock = browserClock(),
  ) {
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
      throw new StreamEngineError("STREAM_INVALID_CONFIG", "Frame scheduler FPS must be an integer between 1 and 60.", { fps });
    }
    this.frameIntervalMs = 1000 / fps;
  }

  start(): void {
    if (this.disposed) throw new StreamEngineError("FRAME_SCHEDULER_FAILED", "A disposed frame scheduler cannot be restarted.");
    if (this.running) return;
    this.running = true;
    this.nextFrameAt = this.clock.now();
    try {
      this.scheduleNext();
    } catch (error) {
      this.running = false;
      this.timer = null;
      throw this.schedulerError(error);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  private scheduleNext(): void {
    if (!this.running || this.disposed) return;
    const delay = Math.max(0, this.nextFrameAt - this.clock.now());
    this.timer = this.clock.setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    this.timer = null;
    if (!this.running || this.disposed) return;
    try {
      this.render();
    } catch (error) {
      this.stop();
      this.onError(error);
      return;
    }

    const now = this.clock.now();
    this.nextFrameAt += this.frameIntervalMs;
    if (this.nextFrameAt <= now) this.nextFrameAt = now + this.frameIntervalMs;
    try {
      this.scheduleNext();
    } catch (error) {
      this.stop();
      this.onError(this.schedulerError(error));
    }
  }

  private schedulerError(error: unknown): StreamEngineError {
    return error instanceof StreamEngineError
      ? error
      : new StreamEngineError("FRAME_SCHEDULER_FAILED", undefined, {
        reason: error instanceof Error ? error.message : "Timer creation failed.",
      });
  }
}
