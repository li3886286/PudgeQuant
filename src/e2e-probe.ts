/**
 * End-to-end probe — drives the PRODUCT stack (ButtplugController + SafetyLayer)
 * against a live Intiface server, exercising a full session lifecycle.
 *
 * This complements the two existing layers of coverage (playbook §6):
 *   - safety.test.ts  unit-tests the safety layer against a FakeController.
 *   - m0-smoke.ts     proves the bare buttplug-js wire path with one vibrate.
 * Neither drives the real controller+safety stack over the wire end to end;
 * this does, which is the coverage fake-controller.ts points at.
 *
 * Capability-adaptive: it inspects the device's actuators and only drives what
 * the device actually exposes, so it runs against any Intiface simulator device
 * (or a real one). Run Intiface Central, "Start Server", add a simulated device:
 *   npm run e2e
 *
 * Not a unit test (it needs live hardware/simulator), so it lives here next to
 * m0-smoke.ts rather than under test/. Exit code is non-zero if any check fails.
 */
import { ButtplugController } from "./buttplug.js";
import { loadConfig } from "./config.js";
import { SafetyLayer } from "./safety.js";
import { ActuatorType, DeviceInfo, TactusConfig, TactusError } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Settle time between drive commands: longer than the rate-limiter window
// (1000 / maxCommandsPerSec) so each command sends rather than coalescing, and
// enough for a real actuator to react.
const SETTLE_MS = 250;

// --- tiny check harness: record every check, never abort early, sum up at end ---

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}
const results: CheckResult[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name} — ${detail}`);
}

/** Assert a boolean condition. */
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) pass(name, detail);
  else fail(name, detail ?? "expected true");
}

/** Assert that a drive call resolves and returns an effective value in range. */
async function expectDrive(
  name: string,
  maxIntensity: number,
  fn: () => Promise<number>,
): Promise<void> {
  try {
    const effective = await fn();
    const inRange = effective >= 0 && effective <= maxIntensity + 1e-9;
    check(name, inRange, `effective=${effective} (cap ${maxIntensity})`);
  } catch (e) {
    fail(name, `unexpected throw: ${errText(e)}`);
  }
}

/** Assert that a call rejects with a TactusError of the expected code. */
async function expectReject(
  name: string,
  code: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    fail(name, `expected a ${code} error, but it resolved`);
  } catch (e) {
    if (e instanceof TactusError && e.code === code) pass(name, `${code}: ${e.message}`);
    else fail(name, `expected ${code}, got: ${errText(e)}`);
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const section = (title: string): void => console.log(`\n${title}`);

// --- the probe ---

async function probe(): Promise<void> {
  const config = loadConfig();
  const controller = new ButtplugController(config);
  const safety = new SafetyLayer(controller, config);

  // Mirror index.ts: drop a device's safety timers when it disconnects.
  controller.onDeviceRemoved((id, name) => {
    console.log(`  [deviceremoved] [${id}] ${name} — clearing safety timers`);
    safety.forgetDevice(id);
  });

  section("1. Connect to Intiface");
  try {
    await controller.connect();
  } catch (e) {
    console.error(`\n✗ ${errText(e)}`);
    console.error("  Checklist:");
    console.error('   - Intiface Central is running and "Start Server" is clicked.');
    console.error("   - A device (simulated or real) has been added.");
    console.error("   - No OTHER Buttplug client holds the connection. Intiface serves a");
    console.error("     SINGLE client at a time, so a live Tactus MCP server (or any other");
    console.error("     app) on this port makes this probe's connect fail. Stop it first.");
    process.exit(1);
  }
  const status = controller.status();
  check("status reports connected", status.connected === true);
  pass("server", status.server_name ?? "(unknown)");

  section("2. Discover a device");
  let devices = controller.listDevices();
  if (devices.length === 0) {
    console.log(`  no devices yet — scanning ${config.scanDefaultMs}ms...`);
    await controller.scan(config.scanDefaultMs);
    devices = controller.listDevices();
  }
  if (devices.length === 0) {
    fail("found a device", "no devices — add a simulated device in Intiface and retry");
    return finish(controller, safety);
  }
  const dev = devices[0];
  const types = new Set<ActuatorType>(dev.actuators.map((a) => a.type));
  check("device has at least one actuator", dev.actuators.length > 0);
  pass("device", `[${dev.id}] ${dev.name} — actuators=[${describeActuators(dev)}]`);

  section("3. Drive every actuator the device exposes (capability-adaptive)");
  if (types.has("vibrate")) {
    await expectDrive("vibrate 30%", config.maxIntensity, () => safety.vibrate(dev.id, 0.3));
    await sleep(SETTLE_MS);
  }
  if (types.has("oscillate")) {
    await expectDrive("oscillate 30%", config.maxIntensity, () => safety.oscillate(dev.id, 0.3));
    await sleep(SETTLE_MS);
  }
  if (types.has("rotate")) {
    await expectDrive("rotate 30% cw", config.maxIntensity, () => safety.rotate(dev.id, 0.3, true));
    await sleep(SETTLE_MS);
  }
  if (types.has("linear")) {
    await expectDrive("linear to 50% over 600ms", 1, () => safety.linear(dev.id, 0.5, 600));
    await sleep(SETTLE_MS);
  }
  await safety.stopDevice(dev.id);
  await sleep(SETTLE_MS);

  section("4. Per-actuator addressing");
  const vibActuators = dev.actuators.filter((a) => a.type === "vibrate");
  if (vibActuators.length >= 2) {
    const [a, b] = vibActuators;
    await expectDrive(`target actuator #${a.index}`, config.maxIntensity, () =>
      safety.vibrate(dev.id, 0.5, { actuatorIndex: a.index }),
    );
    await sleep(SETTLE_MS);
    await expectDrive(`target actuator #${b.index}`, config.maxIntensity, () =>
      safety.vibrate(dev.id, 0.2, { actuatorIndex: b.index }),
    );
    await sleep(SETTLE_MS);
    await expectReject("reject a non-existent actuator index", "NO_ACTUATOR", () =>
      safety.vibrate(dev.id, 0.3, { actuatorIndex: 9999 }),
    );
    await safety.stopDevice(dev.id);
    await sleep(SETTLE_MS);
  } else {
    pass("per-actuator addressing", "skipped — fewer than 2 vibrate actuators");
  }

  section("5. Reject actuator types the device does not have");
  // Settle between checks: a coalesced drive resolves immediately and surfaces
  // its error out of band (not to the caller), so keep each check in its own
  // rate-limiter window to get a synchronous rejection. (This probe found that
  // the limiter's flush path can crash on a rejected coalesced command.)
  if (!types.has("oscillate")) {
    await expectReject("oscillate -> NO_ACTUATOR", "NO_ACTUATOR", () => safety.oscillate(dev.id, 0.3));
    await sleep(SETTLE_MS);
  }
  if (!types.has("rotate")) {
    await expectReject("rotate -> NO_ACTUATOR", "NO_ACTUATOR", () => safety.rotate(dev.id, 0.3, true));
    await sleep(SETTLE_MS);
  }
  if (!types.has("linear")) {
    await expectReject("linear -> NO_ACTUATOR", "NO_ACTUATOR", () => safety.linear(dev.id, 0.5, 500));
    await sleep(SETTLE_MS);
  }

  section("6. Intensity clamp on the wire");
  // A separate safety layer over the SAME controller with a low ceiling: a 0.9
  // request must come back clamped to the ceiling (honesty over optimism).
  if (types.has("vibrate")) {
    const cappedCfg: TactusConfig = { ...config, maxIntensity: 0.3 };
    const capped = new SafetyLayer(controller, cappedCfg);
    const effective = await capped.vibrate(dev.id, 0.9);
    check("0.9 request clamps to 0.3", Math.abs(effective - 0.3) < 1e-9, `effective=${effective}`);
    await capped.shutdown();
    await sleep(SETTLE_MS);
  }

  section("7. Pattern + emergency stop preempts it");
  if (types.has("vibrate")) {
    // ~6s pattern; we stop it mid-run. The precise "no further steps" semantics
    // are unit-tested in safety.test.ts — here we confirm the wire path: the
    // pattern starts, stop_all preempts without error, the link stays healthy.
    safety.startVibratePattern(
      dev.id,
      [
        { intensity: 0.2, durationMs: 300 },
        { intensity: 0.8, durationMs: 300 },
      ],
      10,
    );
    await sleep(700); // a couple of steps have played
    await safety.stopAll();
    check("link healthy after stop_all", controller.status().connected === true);
    pass("stop_all preempted the running pattern");
    await sleep(SETTLE_MS);
  }

  section("8. Error handling");
  await expectReject("unknown device id -> UNKNOWN_DEVICE", "UNKNOWN_DEVICE", () =>
    safety.vibrate(999, 0.3),
  );

  section("9. Recover after stop_all and clean up");
  if (types.has("vibrate")) {
    await expectDrive("re-drive after stop_all", config.maxIntensity, () =>
      safety.vibrate(dev.id, 0.2),
    );
    await sleep(SETTLE_MS);
  }
  await safety.stopDevice(dev.id);

  return finish(controller, safety);
}

async function finish(controller: ButtplugController, safety: SafetyLayer): Promise<void> {
  section("Teardown");
  await safety.shutdown(); // best-effort stop-all + dispose limiters; never throws
  await controller.disconnect().catch(() => {});
  check("disconnected cleanly", controller.status().connected === false);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"=".repeat(48)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const r of failed) console.log(`  ✗ ${r.name} — ${r.detail}`);
    process.exit(1);
  }
  console.log("✓ e2e probe passed — product stack is sound over the wire.");
  process.exit(0);
}

function describeActuators(dev: DeviceInfo): string {
  return dev.actuators.map((a) => `${a.index}:${a.type}/${a.step_count}`).join(", ") || "none";
}

probe().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
