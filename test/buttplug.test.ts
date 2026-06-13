import assert from "node:assert/strict";
import { test } from "node:test";
import { ButtplugController } from "../src/buttplug.js";
import { TactusConfig } from "../src/types.js";

const cfg = (over: Partial<TactusConfig> = {}): TactusConfig => ({
  intifaceUrl: "ws://127.0.0.1:12345",
  maxIntensity: 1.0,
  maxContinuousMs: 600_000,
  scanDefaultMs: 5_000,
  maxCommandsPerSec: 20,
  maxPatternSteps: 200,
  allowUnsafe: false,
  ...over,
});

test("status() is safe to call while disconnected (no throw)", () => {
  // Regression: status() read client.devices.size unconditionally, but that
  // getter throws when the connector is down — so calling status() before
  // connecting (or mid-reconnect) crashed instead of reporting connected:false.
  const controller = new ButtplugController(cfg());
  const status = controller.status(); // must not throw
  assert.equal(status.connected, false);
  assert.equal(status.device_count, 0);
  assert.equal(status.intiface_url, "ws://127.0.0.1:12345");
});
