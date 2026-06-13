import {
  ButtplugClient,
  ButtplugClientDevice,
  ButtplugNodeWebsocketClientConnector,
  DeviceOutput,
  type DeviceOutputCommand,
  type IButtplugClientDeviceFeature,
  InputType,
  OutputType,
} from "buttplug";
import { DeviceController, DriveTarget, ScalarOutput } from "./controller.js";
import {
  ActuatorInfo,
  ActuatorType,
  DeviceInfo,
  ServerStatus,
  TactusConfig,
  TactusError,
} from "./types.js";

/** Buttplug output types we expose as actuators, in display order. */
const OUTPUT_TO_ACTUATOR: ReadonlyArray<readonly [OutputType, ActuatorType]> = [
  [OutputType.Vibrate, "vibrate"],
  [OutputType.Oscillate, "oscillate"],
  [OutputType.Rotate, "rotate"],
  [OutputType.HwPositionWithDuration, "linear"],
  [OutputType.Position, "linear"],
  [OutputType.Constrict, "constrict"],
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * DeviceController backed by Buttplug/Intiface over a local WebSocket.
 * Our code never touches BLE — Intiface owns that, so this is OS-agnostic.
 */
export class ButtplugController implements DeviceController {
  private readonly client: ButtplugClient;
  private serverName?: string;
  private readonly disconnectCbs: Array<() => void> = [];
  private readonly deviceRemovedCbs: Array<(id: number, name: string) => void> = [];
  private readonly deviceAddedCbs: Array<(id: number, name: string) => void> = [];

  constructor(private readonly config: TactusConfig) {
    this.client = new ButtplugClient("Tactus");
    this.client.on("disconnect", () => {
      for (const cb of this.disconnectCbs) cb();
    });
    this.client.on("deviceadded", (d: ButtplugClientDevice) => {
      for (const cb of this.deviceAddedCbs) cb(d.index, d.name);
    });
    this.client.on("deviceremoved", (d: ButtplugClientDevice) => {
      for (const cb of this.deviceRemovedCbs) cb(d.index, d.name);
    });
  }

  async connect(): Promise<void> {
    const connector = new ButtplugNodeWebsocketClientConnector(this.config.intifaceUrl);
    try {
      await this.client.connect(connector);
    } catch {
      throw new TactusError(
        `Intiface is not reachable at ${this.config.intifaceUrl}. ` +
          `Start Intiface Central and click "Start Server", then retry.`,
        "NOT_CONNECTED",
      );
    }
    this.serverName = this.client.serverInfo?.serverName;
  }

  async disconnect(): Promise<void> {
    if (this.client.connected) await this.client.disconnect();
  }

  isConnected(): boolean {
    return this.client.connected;
  }

  status(): ServerStatus {
    const connected = this.client.connected;
    return {
      connected,
      intiface_url: this.config.intifaceUrl,
      server_name: this.serverName,
      // `client.devices` throws when the connector is down, so only read it while
      // connected. status() must be safe to call in ANY state — especially during
      // a reconnect, which is exactly when a caller most wants to know the state.
      device_count: connected ? this.client.devices.size : 0,
    };
  }

  listDevices(): DeviceInfo[] {
    return [...this.client.devices.values()].map((d) => this.describe(d));
  }

  async scan(durationMs: number): Promise<DeviceInfo[]> {
    this.requireConnected();
    const before = new Set(this.client.devices.keys());
    await this.client.startScanning();
    await sleep(durationMs);
    await this.client.stopScanning();
    return [...this.client.devices.values()]
      .filter((d) => !before.has(d.index))
      .map((d) => this.describe(d));
  }

  async getBattery(deviceId: number): Promise<number> {
    const device = this.requireDevice(deviceId);
    try {
      return await device.battery();
    } catch {
      throw new TactusError(`Device ${deviceId} does not report battery.`, "DEVICE_ERROR");
    }
  }

  async output(
    deviceId: number,
    type: ScalarOutput,
    value: number,
    target?: DriveTarget,
  ): Promise<void> {
    const device = this.requireDevice(deviceId);
    const outputType = type === "vibrate" ? OutputType.Vibrate : OutputType.Oscillate;
    const ctor = type === "vibrate" ? DeviceOutput.Vibrate : DeviceOutput.Oscillate;
    await this.runOnFeatures(device, outputType, type, () => ctor.percent(value), target);
  }

  async rotate(
    deviceId: number,
    speed: number,
    clockwise: boolean,
    target?: DriveTarget,
  ): Promise<void> {
    const device = this.requireDevice(deviceId);
    await this.runOnFeatures(device, OutputType.Rotate, "rotate", (f) => {
      const range = f.output(OutputType.Rotate)!.valueRange;
      return DeviceOutput.Rotate.value(rotateValue(range, speed, clockwise));
    }, target);
  }

  async linear(
    deviceId: number,
    position: number,
    durationMs: number,
    target?: DriveTarget,
  ): Promise<void> {
    const device = this.requireDevice(deviceId);
    const outputType = device.hasOutput(OutputType.HwPositionWithDuration)
      ? OutputType.HwPositionWithDuration
      : OutputType.Position;
    const cmd = DeviceOutput.PositionWithDuration.percent(position, durationMs);
    await this.runOnFeatures(device, outputType, "linear", () => cmd, target);
  }

  async stopDevice(deviceId: number): Promise<void> {
    await this.requireDevice(deviceId).stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.client.devices.values()].map((d) => d.stop()));
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb);
  }

  onDeviceAdded(cb: (id: number, name: string) => void): void {
    this.deviceAddedCbs.push(cb);
  }

  onDeviceRemoved(cb: (id: number, name: string) => void): void {
    this.deviceRemovedCbs.push(cb);
  }

  // --- internals ---

  /** Resolve the target features, build a per-feature command, and send. */
  private async runOnFeatures(
    device: ButtplugClientDevice,
    outputType: OutputType,
    label: string,
    build: (f: IButtplugClientDeviceFeature) => DeviceOutputCommand,
    target?: DriveTarget,
  ): Promise<void> {
    const features = this.featuresFor(device, outputType, label, target);
    try {
      await Promise.all(features.map((f) => f.runOutput(build(f))));
    } catch (e) {
      if (e instanceof TactusError) throw e;
      throw new TactusError(
        `Device ${device.index} rejected the ${label} command: ${buttplugErrorText(e)}`,
        "DEVICE_ERROR",
      );
    }
  }

  private featuresFor(
    device: ButtplugClientDevice,
    outputType: OutputType,
    label: string,
    target?: DriveTarget,
  ): IButtplugClientDeviceFeature[] {
    let features = [...device.features.values()].filter((f) => f.hasOutput(outputType));
    if (target?.actuatorIndex !== undefined) {
      features = features.filter((f) => f.index === target.actuatorIndex);
      if (features.length === 0) {
        throw new TactusError(
          `Device ${device.index} has no ${label} actuator at index ${target.actuatorIndex}.`,
          "NO_ACTUATOR",
        );
      }
    }
    if (features.length === 0) {
      throw new TactusError(`Device ${device.index} has no ${label} actuator.`, "NO_ACTUATOR");
    }
    return features;
  }

  private describe(device: ButtplugClientDevice): DeviceInfo {
    const actuators: ActuatorInfo[] = [];
    let hasBattery = false;
    for (const f of device.features.values()) {
      // A feature can expose several output types that collapse to the same
      // actuator type (e.g. Position + HwPositionWithDuration → "linear");
      // emit at most one actuator per type per feature.
      const seen = new Set<ActuatorType>();
      for (const [outputType, actuatorType] of OUTPUT_TO_ACTUATOR) {
        if (seen.has(actuatorType)) continue;
        const out = f.output(outputType);
        if (out) {
          seen.add(actuatorType);
          actuators.push({ index: f.index, type: actuatorType, step_count: out.valueRange[1] });
        }
      }
      if (f.hasInput(InputType.Battery)) hasBattery = true;
    }
    return { id: device.index, name: device.name, actuators, has_battery: hasBattery };
  }

  private requireConnected(): void {
    if (!this.client.connected) {
      throw new TactusError(
        `Not connected to Intiface at ${this.config.intifaceUrl}. ` +
          `Start Intiface Central and click "Start Server".`,
        "NOT_CONNECTED",
      );
    }
  }

  private requireDevice(deviceId: number): ButtplugClientDevice {
    this.requireConnected();
    const device = this.client.devices.get(deviceId);
    if (!device) {
      const valid = [...this.client.devices.keys()].join(", ") || "none";
      throw new TactusError(`Unknown device id ${deviceId}. Valid ids: [${valid}].`, "UNKNOWN_DEVICE");
    }
    return device;
  }
}

/** Turn a Buttplug error (often a JSON string like
 *  `{"ButtplugDeviceError":{"MessageNotSupported":"OutputCmd"}}`) into a short
 *  human-readable phrase. */
function buttplugErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const inner = (parsed.ButtplugDeviceError ?? parsed.ButtplugError ?? parsed) as Record<string, unknown>;
    const [kind, detail] = Object.entries(inner)[0] ?? [];
    if (kind) return `${kind}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  } catch {
    /* not JSON — fall through */
  }
  return raw;
}

/** Map a 0..1 speed + direction onto a feature's (possibly signed) value range. */
function rotateValue(range: readonly [number, number], speed: number, clockwise: boolean): number {
  const [min, max] = range;
  if (clockwise || min >= 0) return Math.round(max * speed);
  return Math.round(min * speed); // counter-clockwise via the negative side of the range
}
