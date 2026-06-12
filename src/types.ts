/** Shared, protocol-agnostic types for Tactus. */

export type ActuatorType =
  | "vibrate"
  | "oscillate"
  | "rotate"
  | "linear"
  | "constrict"
  | "inflate"
  | "unknown";

/** A single drivable output on a device (maps to one Buttplug feature output). */
export interface ActuatorInfo {
  index: number;
  type: ActuatorType;
  /** Number of discrete steps the actuator accepts (from the feature value range). */
  step_count: number;
}

export interface DeviceInfo {
  id: number;
  name: string;
  actuators: ActuatorInfo[];
  has_battery: boolean;
  /** 0..1, present only when reported. */
  battery?: number;
}

export interface ServerStatus {
  connected: boolean;
  intiface_url: string;
  server_name?: string;
  device_count: number;
}

export interface TactusConfig {
  intifaceUrl: string;
  /** Clamp ceiling for drive intensity, 0..1. */
  maxIntensity: number;
  /** Watchdog auto-stop after this many ms of uninterrupted drive. */
  maxContinuousMs: number;
  scanDefaultMs: number;
  /** Per-device command rate cap; excess is coalesced. */
  maxCommandsPerSec: number;
  maxPatternSteps: number;
  /** When true, the intensity clamp is disabled (explicitly gated, discouraged). */
  allowUnsafe: boolean;
}

/** Codes for actionable, non-crashing failures surfaced to callers. */
export type TactusErrorCode =
  | "NOT_CONNECTED"
  | "UNKNOWN_DEVICE"
  | "NO_ACTUATOR"
  | "INVALID_INPUT"
  | "DEVICE_ERROR";

export class TactusError extends Error {
  constructor(
    message: string,
    readonly code: TactusErrorCode,
  ) {
    super(message);
    this.name = "TactusError";
  }
}
