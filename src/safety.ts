import { DeviceController, DriveTarget, ScalarOutput } from "./controller.js";
import { TactusConfig, TactusError } from "./types.js";

export interface PatternStep {
  intensity: number;
  durationMs: number;
}

interface PatternRun {
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Per-device rate limiter with trailing coalescing: commands under the cap go
 * straight through; bursts above it collapse to the latest value, flushed at
 * the rate boundary. Protects BLE from being flooded (spec §7.4).
 */
class RateLimiter {
  private lastSentAt = 0;
  private pending?: () => Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly minIntervalMs: number) {}

  submit(action: () => Promise<void>): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (elapsed >= this.minIntervalMs) {
      this.lastSentAt = now;
      return action(); // under the cap — await and propagate errors
    }
    // Over the cap: keep only the latest command, flush when the window opens.
    this.pending = action;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const next = this.pending;
        this.pending = undefined;
        if (next) {
          this.lastSentAt = Date.now();
          void next();
        }
      }, this.minIntervalMs - elapsed);
      this.timer.unref?.();
    }
    return Promise.resolve();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}

/**
 * Wraps a DeviceController with the safety guarantees that are Tactus's headline
 * feature (spec §7.4, playbook §3): intensity clamp, an INDEPENDENT watchdog
 * timer (not check-on-next-call), per-device rate limiting, stop-preemptible
 * patterns, and fail-safe stops that retry rather than assume success.
 */
export class SafetyLayer {
  private readonly watchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly limiters = new Map<number, RateLimiter>();
  private readonly patterns = new Map<number, PatternRun>();

  constructor(
    private readonly controller: DeviceController,
    private readonly config: TactusConfig,
  ) {}

  /** Drive methods return the EFFECTIVE value actually applied (post-clamp), so
   *  callers can see when a request was clamped — honesty over optimism. */
  async vibrate(deviceId: number, intensity: number, target?: DriveTarget): Promise<number> {
    return this.driveScalar(deviceId, "vibrate", intensity, target);
  }

  async oscillate(deviceId: number, intensity: number, target?: DriveTarget): Promise<number> {
    return this.driveScalar(deviceId, "oscillate", intensity, target);
  }

  async rotate(
    deviceId: number,
    speed: number,
    clockwise: boolean,
    target?: DriveTarget,
  ): Promise<number> {
    const v = this.clampIntensity(speed);
    this.cancelPattern(deviceId);
    this.armWatchdog(deviceId);
    await this.submit(deviceId, () => this.controller.rotate(deviceId, v, clockwise, target));
    return v;
  }

  async linear(
    deviceId: number,
    position: number,
    durationMs: number,
    target?: DriveTarget,
  ): Promise<number> {
    const p = Math.max(0, Math.min(1, position)); // position is a coordinate, not an intensity
    this.cancelPattern(deviceId);
    this.armWatchdog(deviceId);
    await this.submit(deviceId, () => this.controller.linear(deviceId, p, durationMs, target));
    return p;
  }

  /**
   * Kick off a server-side timed pattern and return immediately. Playing is
   * driven by chained timers (NOT an awaited sleep), so a single tool call
   * never occupies the serial stdio handler — stop_* can always preempt it
   * (playbook §3.4).
   */
  startVibratePattern(
    deviceId: number,
    steps: readonly PatternStep[],
    repeat: number,
    target?: DriveTarget,
  ): void {
    this.cancelPattern(deviceId);
    const flat: PatternStep[] = [];
    for (let r = 0; r < repeat; r++) flat.push(...steps);

    const run: PatternRun = { cancelled: false };
    this.patterns.set(deviceId, run);

    let i = 0;
    const next = (): void => {
      if (run.cancelled) return;
      if (i >= flat.length) {
        this.patterns.delete(deviceId);
        void this.controller.stopDevice(deviceId).catch(() => {});
        return;
      }
      const step = flat[i++];
      this.armWatchdog(deviceId);
      void this.submit(deviceId, () =>
        this.controller.output(deviceId, "vibrate", this.clampIntensity(step.intensity), target),
      );
      run.timer = setTimeout(next, step.durationMs);
      run.timer.unref?.();
    };
    next();
  }

  /** Fail-safe stop: if we cannot confirm the device stopped, retry — never
   *  optimistically report success (playbook §3.1). */
  async stopDevice(deviceId: number): Promise<void> {
    this.clearWatchdog(deviceId);
    this.cancelPattern(deviceId);
    await this.retry(() => this.controller.stopDevice(deviceId));
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.watchdogs.keys()]) this.clearWatchdog(id);
    for (const id of [...this.patterns.keys()]) this.cancelPattern(id);
    await this.retry(() => this.controller.stopAll());
  }

  /** Drop all per-device state for a device that has disconnected. No point
   *  keeping a watchdog/pattern/limiter alive for a device that is gone. */
  forgetDevice(deviceId: number): void {
    this.clearWatchdog(deviceId);
    this.cancelPattern(deviceId);
    const limiter = this.limiters.get(deviceId);
    if (limiter) {
      limiter.dispose();
      this.limiters.delete(deviceId);
    }
  }

  /** Best-effort emergency stop for shutdown paths; never throws. */
  async shutdown(): Promise<void> {
    for (const l of this.limiters.values()) l.dispose();
    this.limiters.clear();
    try {
      await this.stopAll();
    } catch {
      /* shutting down — nothing more we can do here */
    }
  }

  // --- internals ---

  private async driveScalar(
    deviceId: number,
    type: ScalarOutput,
    intensity: number,
    target?: DriveTarget,
  ): Promise<number> {
    const v = this.clampIntensity(intensity);
    this.cancelPattern(deviceId);
    this.armWatchdog(deviceId);
    await this.submit(deviceId, () => this.controller.output(deviceId, type, v, target));
    return v;
  }

  private clampIntensity(v: number): number {
    return Math.max(0, Math.min(this.config.maxIntensity, v));
  }

  private submit(deviceId: number, action: () => Promise<void>): Promise<void> {
    let limiter = this.limiters.get(deviceId);
    if (!limiter) {
      limiter = new RateLimiter(1000 / this.config.maxCommandsPerSec);
      this.limiters.set(deviceId, limiter);
    }
    return limiter.submit(action);
  }

  /** (Re)arm the independent auto-stop timer for a device. */
  private armWatchdog(deviceId: number): void {
    this.clearWatchdog(deviceId);
    const timer = setTimeout(() => {
      this.watchdogs.delete(deviceId);
      void this.retry(() => this.controller.stopDevice(deviceId)).catch(() => {});
    }, this.config.maxContinuousMs);
    timer.unref?.();
    this.watchdogs.set(deviceId, timer);
  }

  private clearWatchdog(deviceId: number): void {
    const timer = this.watchdogs.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.watchdogs.delete(deviceId);
    }
  }

  private cancelPattern(deviceId: number): void {
    const run = this.patterns.get(deviceId);
    if (run) {
      run.cancelled = true;
      if (run.timer) clearTimeout(run.timer);
      this.patterns.delete(deviceId);
    }
  }

  private async retry(fn: () => Promise<void>, attempts = 3): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await fn();
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new TactusError(
      `Could not confirm stop after ${attempts} attempts: ${String(lastErr)}`,
      "DEVICE_ERROR",
    );
  }
}
