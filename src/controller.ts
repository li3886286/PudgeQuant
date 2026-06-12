import { DeviceInfo, ServerStatus } from "./types.js";

/** Scalar outputs driven by a single 0..1 intensity. */
export type ScalarOutput = "vibrate" | "oscillate";

export interface DriveTarget {
  /** Restrict to one actuator (Buttplug feature index); omit to drive all matching. */
  actuatorIndex?: number;
}

/**
 * Protocol-agnostic control core. MCP is the flagship adapter over this
 * interface; REST/SDK adapters can be added later without touching callers
 * (spec §1/§6). Keeping Buttplug behind this seam is what makes that possible.
 *
 * These are RAW ops — clamping, watchdog, rate limiting and fail-safe stop
 * live in the safety layer that wraps this (safety.ts).
 */
export interface DeviceController {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  status(): ServerStatus;

  listDevices(): DeviceInfo[];
  scan(durationMs: number): Promise<DeviceInfo[]>;
  getBattery(deviceId: number): Promise<number>;

  output(deviceId: number, type: ScalarOutput, value: number, target?: DriveTarget): Promise<void>;
  rotate(deviceId: number, speed: number, clockwise: boolean, target?: DriveTarget): Promise<void>;
  linear(deviceId: number, position: number, durationMs: number, target?: DriveTarget): Promise<void>;

  stopDevice(deviceId: number): Promise<void>;
  stopAll(): Promise<void>;

  /** Register a callback fired when the transport to Intiface drops. */
  onDisconnect(cb: () => void): void;
}
