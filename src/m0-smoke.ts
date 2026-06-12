/**
 * M0 smoke test — de-risk the whole stack before building the MCP server.
 *
 * Proves the chain: this process (Buttplug client) → Intiface → device.
 * Run Intiface Central, click "Start Server", add a simulated device, then:
 *   npm run m0
 *
 * This is a throwaway harness, NOT the product. The real MCP server lives in
 * index.ts/server.ts once this proves the buttplug-js wire path works.
 */
import {
  ButtplugClient,
  ButtplugClientDevice,
  ButtplugNodeWebsocketClientConnector,
  DeviceOutput,
  OutputType,
} from "buttplug";

const INTIFACE_URL = process.env.INTIFACE_URL ?? "ws://127.0.0.1:12345";
const SCAN_MS = 5000;
const VIBRATE_INTENSITY = 0.5;
const VIBRATE_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(client: ButtplugClient): Promise<void> {
  const connector = new ButtplugNodeWebsocketClientConnector(INTIFACE_URL);
  try {
    await client.connect(connector);
  } catch (e) {
    console.error(`\n✗ Could not reach Intiface at ${INTIFACE_URL}.`);
    console.error(`  Start Intiface Central and click "Start Server", then retry.`);
    console.error(`  cause: ${e}`);
    process.exit(1);
  }
  console.log(`✓ Connected. server: ${client.serverInfo?.serverName ?? "(unknown)"}`);
}

async function scanForDevices(client: ButtplugClient): Promise<ButtplugClientDevice[]> {
  console.log(`Scanning for devices (${SCAN_MS}ms)...`);
  await client.startScanning();
  await sleep(SCAN_MS);
  await client.stopScanning();
  return [...client.devices.values()];
}

function describe(device: ButtplugClientDevice): string {
  const outputs = Object.values(OutputType).filter((t) => device.hasOutput(t as OutputType));
  return `${device.name} (index ${device.index}) outputs=[${outputs.join(", ") || "none"}]`;
}

async function main(): Promise<void> {
  const client = new ButtplugClient("Tactus M0 Smoke Test");
  client.addListener("deviceadded", (d: ButtplugClientDevice) =>
    console.log(`[deviceadded] ${describe(d)}`),
  );

  await connect(client);

  const devices = await scanForDevices(client);
  if (devices.length === 0) {
    console.error("✗ No devices found. Add a simulated device in Intiface (or pair a real one) and retry.");
    await client.disconnect();
    process.exit(1);
  }

  const device = devices[0];
  console.log(`\nUsing: ${describe(device)}`);

  if (!device.hasOutput(OutputType.Vibrate)) {
    console.error(`✗ Device has no Vibrate output; pick a vibrating device for the M0 test.`);
    await client.disconnect();
    process.exit(1);
  }

  console.log(`Vibrate ${VIBRATE_INTENSITY * 100}% for ${VIBRATE_MS}ms...`);
  await device.runOutput(DeviceOutput.Vibrate.percent(VIBRATE_INTENSITY));
  await sleep(VIBRATE_MS);

  console.log("Stop.");
  await device.stop();

  await client.disconnect();
  console.log("\n✓ M0 smoke test complete — LLM→MCP→Intiface→device wire path is sound.");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
