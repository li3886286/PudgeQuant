import assert from "node:assert/strict";
import { test } from "node:test";
import { enforcePatternBounds } from "../src/server.js";
import { SafetyLayer } from "../src/safety.js";
import { TactusConfig } from "../src/types.js";
import { FakeController } from "./fake-controller.js";

const cfg = (over: Partial<TactusConfig> = {}): TactusConfig => ({
  intifaceUrl: "fake",
  maxIntensity: 1.0,
  maxContinuousMs: 600_000,
  scanDefaultMs: 5_000,
  maxCommandsPerSec: 1_000, // ~no throttling unless a test opts in
  maxPatternSteps: 200,
  allowUnsafe: false,
  ...over,
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("clamps intensity to MAX_INTENSITY and returns the effective value", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg({ maxIntensity: 0.3 }));
  const effective = await safety.vibrate(0, 0.9);
  assert.equal(effective, 0.3);
  const out = fc.callsTo("output").at(-1);
  assert.deepEqual(out?.args.slice(0, 3), [0, "vibrate", 0.3]);
});

test("watchdog auto-stops the device after MAX_CONTINUOUS_MS", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg({ maxContinuousMs: 40 }));
  await safety.vibrate(0, 0.5);
  assert.equal(fc.callsTo("stopDevice").length, 0, "must not stop immediately");
  await sleep(90);
  assert.ok(fc.callsTo("stopDevice").length >= 1, "watchdog should have stopped the device");
});

test("a new command resets the watchdog", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg({ maxContinuousMs: 60 }));
  await safety.vibrate(0, 0.5);
  await sleep(40);
  await safety.vibrate(0, 0.6); // resets the timer
  await sleep(40); // 80ms since first command, only 40ms since the reset
  assert.equal(fc.callsTo("stopDevice").length, 0, "reset should have deferred the stop");
  await sleep(50);
  assert.ok(fc.callsTo("stopDevice").length >= 1, "watchdog should fire after the reset window");
});

test("stop_all preempts a running pattern", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg());
  safety.startVibratePattern(
    0,
    [
      { intensity: 0.2, durationMs: 30 },
      { intensity: 0.8, durationMs: 30 },
    ],
    20,
  );
  await sleep(45); // a couple of steps have played
  const before = fc.callsTo("output").length;
  assert.ok(before >= 1, "pattern should have started driving");
  await safety.stopAll();
  await sleep(150); // well past several more steps had it not been cancelled
  assert.equal(fc.callsTo("output").length, before, "no further steps after stop_all");
  assert.ok(fc.callsTo("stopAll").length >= 1);
});

test("fail-safe stop retries until the stop is confirmed", async () => {
  const fc = new FakeController();
  fc.stopDeviceFailTimes = 2; // first two attempts reject
  const safety = new SafetyLayer(fc, cfg());
  await safety.stopDevice(0); // should succeed on the 3rd attempt
  assert.equal(fc.callsTo("stopDevice").length, 3);
});

test("fail-safe stop throws if it can never confirm the stop", async () => {
  const fc = new FakeController();
  fc.stopDeviceFailTimes = 99; // always rejects
  const safety = new SafetyLayer(fc, cfg());
  await assert.rejects(() => safety.stopDevice(0), /Could not confirm stop/);
});

test("rate limiter coalesces a burst to the latest value", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg({ maxCommandsPerSec: 20 })); // 50ms window
  await safety.vibrate(0, 0.1); // passes through immediately
  await safety.vibrate(0, 0.2); // coalesced
  await safety.vibrate(0, 0.3); // coalesced; latest wins
  assert.equal(fc.callsTo("output").length, 1, "only the first command sends immediately");
  await sleep(90); // let the window open and flush
  const calls = fc.callsTo("output");
  assert.equal(calls.length, 2, "burst collapses to two sends, not three");
  assert.equal(calls.at(-1)?.args[2], 0.3, "the latest value is the one flushed");
});

test("a coalesced command that fails is swallowed, not crashed", async () => {
  // Regression: the rate limiter used to flush its trailing command with a bare
  // `void next()`, so a coalesced command that rejected (device error, lost
  // actuator, dropped link) became an unhandled rejection and crashed the whole
  // server. The flush must swallow the failure instead.
  const rejections: unknown[] = [];
  const onRejection = (e: unknown): void => {
    rejections.push(e);
  };
  process.on("unhandledRejection", onRejection);
  try {
    const fc = new FakeController();
    const safety = new SafetyLayer(fc, cfg({ maxCommandsPerSec: 20 })); // 50ms window
    await safety.vibrate(0, 0.1); // sent immediately, succeeds, opens the window
    fc.failOutput = true; // the next actual send will reject
    await safety.vibrate(0, 0.2); // coalesced — resolves to the caller right away
    await safety.vibrate(0, 0.3); // coalesced; this is what the window flushes
    await sleep(90); // window opens, flush fires next() which now rejects
    assert.equal(rejections.length, 0, "coalesced failure must not become an unhandled rejection");
    assert.ok(fc.callsTo("output").length >= 2, "the trailing command was actually attempted");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("watchdogs fire independently per device", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg({ maxContinuousMs: 40 }));
  await safety.vibrate(0, 0.5);
  await safety.vibrate(1, 0.5);
  await sleep(90);
  const stopped = fc.callsTo("stopDevice").map((c) => c.args[0]).sort();
  assert.deepEqual(stopped, [0, 1], "both devices' watchdogs should have fired");
});

test("stop_all clears every watchdog so none fire afterward", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg({ maxContinuousMs: 50 }));
  await safety.vibrate(0, 0.5);
  await safety.vibrate(1, 0.5);
  await safety.stopAll();
  const stopsAfterStopAll = fc.callsTo("stopDevice").length;
  await sleep(90);
  assert.equal(
    fc.callsTo("stopDevice").length,
    stopsAfterStopAll,
    "no watchdog should fire after stop_all cleared them",
  );
  assert.ok(fc.callsTo("stopAll").length >= 1);
});

test("stop_device leaves another device's watchdog running", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg({ maxContinuousMs: 50 }));
  await safety.vibrate(0, 0.5);
  await safety.vibrate(1, 0.5);
  await safety.stopDevice(0); // explicit stop for device 0 only
  await sleep(90); // device 1's watchdog should still fire
  const stoppedIds = fc.callsTo("stopDevice").map((c) => c.args[0]);
  assert.ok(stoppedIds.includes(1), "device 1's watchdog should still auto-stop it");
});

test("forgetDevice cancels a disconnected device's watchdog", async () => {
  const fc = new FakeController();
  const safety = new SafetyLayer(fc, cfg({ maxContinuousMs: 40 }));
  await safety.vibrate(0, 0.5);
  safety.forgetDevice(0); // device dropped (e.g. out of range)
  await sleep(80);
  assert.equal(fc.callsTo("stopDevice").length, 0, "no watchdog should fire for a forgotten device");
});

test("pattern bounds: rejects too many steps", () => {
  const steps = Array.from({ length: 5 }, () => ({ duration_ms: 10 }));
  assert.throws(() => enforcePatternBounds(steps, 1, cfg({ maxPatternSteps: 3 })), /max is 3/);
});

test("pattern bounds: rejects total duration over the limit", () => {
  const steps = [{ duration_ms: 100 }];
  assert.throws(() => enforcePatternBounds(steps, 10, cfg({ maxContinuousMs: 500 })), /exceeds/);
});

test("pattern bounds: accepts a pattern within limits", () => {
  const steps = [{ duration_ms: 100 }, { duration_ms: 100 }];
  assert.doesNotThrow(() => enforcePatternBounds(steps, 2, cfg({ maxPatternSteps: 10, maxContinuousMs: 5_000 })));
});
