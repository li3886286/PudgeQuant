import { DeviceController, DriveTarget, ScalarOutput } from "../src/controller.js";
import { DeviceInfo, ServerStatus } from "../src/types.js";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * In-memory DeviceController for unit tests. Records every call and can be told
 * to fail the first N stopDevice attempts (to exercise fail-safe retry).
 *
 * Note: the real Buttplug wire path is covered separately by the M0 smoke test
 * and the end-to-end probe against the Intiface simulator — we do NOT rely on
 * this fake for that coverage (playbook §6).
 */
export class FakeController implements DeviceController {
  readonly calls: RecordedCall[] = [];
  stopDeviceFailTimes = 0;
  private connected = true;

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  status(): ServerStatus {
    return { connected: this.connected, intiface_url: "fake", device_count: 0 };
  }
  listDevices(): DeviceInfo[] {
    return [];
  }
  async scan(): Promise<DeviceInfo[]> {
    return [];
  }
  async getBattery(): Promise<number> {
    return 1;
  }
  async output(deviceId: number, type: ScalarOutput, value: number, target?: DriveTarget): Promise<void> {
    this.record("output", deviceId, type, value, target);
  }
  async rotate(deviceId: number, speed: number, clockwise: boolean, target?: DriveTarget): Promise<void> {
    this.record("rotate", deviceId, speed, clockwise, target);
  }
  async linear(deviceId: number, position: number, durationMs: number, target?: DriveTarget): Promise<void> {
    this.record("linear", deviceId, position, durationMs, target);
  }
  async stopDevice(deviceId: number): Promise<void> {
    this.record("stopDevice", deviceId);
    if (this.callsTo("stopDevice").length <= this.stopDeviceFailTimes) {
      throw new Error("simulated stop failure");
    }
  }
  async stopAll(): Promise<void> {
    this.record("stopAll");
  }
  onDisconnect(): void {
    /* no-op for tests */
  }
  onDeviceAdded(): void {
    /* no-op for tests */
  }
  onDeviceRemoved(): void {
    /* no-op for tests */
  }
}
