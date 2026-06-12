import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DeviceController } from "./controller.js";
import { SafetyLayer, type PatternStep } from "./safety.js";
import { TactusConfig, TactusError } from "./types.js";

const PKG_VERSION = "0.0.1";

/** Server-level guidance; some clients ignore this, hence the per-tool prefixes too. */
const INSTRUCTIONS =
  "Tactus is a content-agnostic hardware control layer. It forwards device " +
  "control commands only and generates no content. Always confirm a device " +
  "exists via list_devices before driving it. Intensity is normalized 0.0-1.0. " +
  "Use stop_all to immediately halt everything.";

const DRIVE_PREFIX = "[Hardware control] Forwards a command to physical hardware. ";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const text = (s: string): { type: "text"; text: string }[] => [{ type: "text", text: s }];

const ok = (message: string, structured?: Record<string, unknown>): ToolResult => ({
  content: text(message),
  ...(structured ? { structuredContent: structured } : {}),
});

const fail = (e: unknown): ToolResult => {
  const message = e instanceof TactusError ? e.message : `Unexpected error: ${String(e)}`;
  return { content: text(message), isError: true };
};

const deviceId = z.number().int().nonnegative().describe("Device id from list_devices");
const unit = (label: string) => z.number().min(0).max(1).describe(`${label}, 0.0-1.0`);
const actuatorIndex = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("Restrict to one actuator index; omit to drive all matching actuators");

/** Register every Tactus tool on the given server. */
export function registerTools(
  server: McpServer,
  safety: SafetyLayer,
  controller: DeviceController,
  config: TactusConfig,
): void {
  // --- discovery / status ---

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description: "List currently connected devices and their actuators.",
      inputSchema: {},
    },
    async () => {
      try {
        const devices = controller.listDevices();
        return ok(`${devices.length} device(s) connected.`, { devices, status: controller.status() });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "server_status",
    {
      title: "Server status",
      description: "Report connection status to Intiface and device count.",
      inputSchema: {},
    },
    async () => ok("Status.", { status: controller.status() }),
  );

  server.registerTool(
    "scan_for_devices",
    {
      title: "Scan for devices",
      description: "Scan for new devices for a duration, then return any newly found.",
      inputSchema: { duration_ms: z.number().int().positive().optional() },
    },
    async ({ duration_ms }) => {
      try {
        const found = await controller.scan(duration_ms ?? config.scanDefaultMs);
        return ok(`Found ${found.length} new device(s).`, { devices: found });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_battery",
    {
      title: "Get battery",
      description: "Read battery level (0.0-1.0) for a device that reports it.",
      inputSchema: { device_id: deviceId },
    },
    async ({ device_id }) => {
      try {
        const battery = await controller.getBattery(device_id);
        return ok(`Battery: ${Math.round(battery * 100)}%`, { device_id, battery });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- drive (all clamped + watchdog-tracked via the safety layer) ---

  server.registerTool(
    "vibrate",
    {
      title: "Vibrate",
      description: DRIVE_PREFIX + "Set vibration intensity on a device.",
      inputSchema: { device_id: deviceId, intensity: unit("Vibration intensity"), actuator_index: actuatorIndex },
    },
    async ({ device_id, intensity, actuator_index }) => {
      try {
        const effective = await safety.vibrate(device_id, intensity, { actuatorIndex: actuator_index });
        return ok(driveMsg("Vibrating", device_id, intensity, effective), {
          device_id,
          intensity: effective,
          requested: intensity,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "oscillate",
    {
      title: "Oscillate",
      description: DRIVE_PREFIX + "Set oscillation intensity on a device.",
      inputSchema: { device_id: deviceId, intensity: unit("Oscillation intensity"), actuator_index: actuatorIndex },
    },
    async ({ device_id, intensity, actuator_index }) => {
      try {
        const effective = await safety.oscillate(device_id, intensity, { actuatorIndex: actuator_index });
        return ok(driveMsg("Oscillating", device_id, intensity, effective), {
          device_id,
          intensity: effective,
          requested: intensity,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "rotate",
    {
      title: "Rotate",
      description: DRIVE_PREFIX + "Set rotation speed (and direction) on a device.",
      inputSchema: {
        device_id: deviceId,
        speed: unit("Rotation speed"),
        clockwise: z.boolean().optional().describe("Direction; honored only if the device supports it"),
        actuator_index: actuatorIndex,
      },
    },
    async ({ device_id, speed, clockwise, actuator_index }) => {
      try {
        const effective = await safety.rotate(device_id, speed, clockwise ?? true, { actuatorIndex: actuator_index });
        return ok(driveMsg("Rotating", device_id, speed, effective), {
          device_id,
          speed: effective,
          requested: speed,
          clockwise: clockwise ?? true,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "linear",
    {
      title: "Linear stroke",
      description: DRIVE_PREFIX + "Move a stroker to a position over a duration.",
      inputSchema: {
        device_id: deviceId,
        position: unit("Target position"),
        duration_ms: z.number().int().positive().describe("Time to reach the position, ms"),
        actuator_index: actuatorIndex,
      },
    },
    async ({ device_id, position, duration_ms, actuator_index }) => {
      try {
        const effective = await safety.linear(device_id, position, duration_ms, { actuatorIndex: actuator_index });
        return ok(`Moving device ${device_id} to ${pct(effective)} over ${duration_ms}ms.`, {
          device_id,
          position: effective,
          duration_ms,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibrate_pattern",
    {
      title: "Vibrate pattern",
      description: DRIVE_PREFIX + "Play a timed multi-step vibration pattern; interruptible by any stop.",
      inputSchema: {
        device_id: deviceId,
        steps: z
          .array(z.object({ intensity: unit("Step intensity"), duration_ms: z.number().int().positive() }))
          .min(1),
        repeat: z.number().int().positive().optional(),
        actuator_index: actuatorIndex,
      },
    },
    async ({ device_id, steps, repeat, actuator_index }) => {
      try {
        const count = repeat ?? 1;
        enforcePatternBounds(steps, count, config);
        const pattern: PatternStep[] = steps.map((s) => ({ intensity: s.intensity, durationMs: s.duration_ms }));
        safety.startVibratePattern(device_id, pattern, count, { actuatorIndex: actuator_index });
        return ok(`Started pattern on device ${device_id} (${steps.length} steps x${count}).`, {
          device_id,
          steps: steps.length,
          repeat: count,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- stop (always available, never clamped away) ---

  server.registerTool(
    "stop_device",
    {
      title: "Stop device",
      description: "Stop all actuators on one device.",
      inputSchema: { device_id: deviceId },
    },
    async ({ device_id }) => {
      try {
        await safety.stopDevice(device_id);
        return ok(`Stopped device ${device_id}.`, { device_id, stopped: true });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "stop_all",
    {
      title: "Stop all (emergency)",
      description: "Immediately stop every connected device. Emergency stop.",
      inputSchema: {},
    },
    async () => {
      try {
        await safety.stopAll();
        return ok("Stopped all devices.", { stopped: true });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

export function makeServer(): McpServer {
  return new McpServer({ name: "tactus", version: PKG_VERSION }, { instructions: INSTRUCTIONS });
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Human-readable drive message that notes when the request was clamped. */
const driveMsg = (verb: string, deviceId: number, requested: number, effective: number): string =>
  effective < requested
    ? `${verb} device ${deviceId} at ${pct(effective)} (clamped from ${pct(requested)} by MAX_INTENSITY).`
    : `${verb} device ${deviceId} at ${pct(effective)}.`;

/** Server-side hard bounds for patterns — never trust client schema alone (playbook §4). */
export function enforcePatternBounds(
  steps: readonly { duration_ms: number }[],
  repeat: number,
  config: TactusConfig,
): void {
  if (steps.length > config.maxPatternSteps) {
    throw new TactusError(
      `Pattern has ${steps.length} steps; max is ${config.maxPatternSteps}.`,
      "INVALID_INPUT",
    );
  }
  const total = steps.reduce((sum, s) => sum + s.duration_ms, 0) * repeat;
  if (total > config.maxContinuousMs) {
    throw new TactusError(
      `Pattern total duration ${total}ms exceeds the ${config.maxContinuousMs}ms limit.`,
      "INVALID_INPUT",
    );
  }
}
