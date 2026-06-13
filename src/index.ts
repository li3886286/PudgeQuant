#!/usr/bin/env node
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ButtplugController } from "./buttplug.js";
import { loadConfig } from "./config.js";
import { SafetyLayer } from "./safety.js";
import { makeServer, registerTools } from "./server.js";

// Single source of truth for the version: package.json (sits one level above
// dist/ at runtime). Avoids hard-coding the version in more than one place.
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// All logging goes to stderr — stdout is the JSON-RPC channel for stdio transport.
const log = (msg: string): void => console.error(`[tactus] ${msg}`);

async function main(): Promise<void> {
  const config = loadConfig();
  const controller = new ButtplugController(config);
  const safety = new SafetyLayer(controller, config);
  const server = makeServer(version);
  registerTools(server, safety, controller, config);

  let shuttingDown = false;

  // Keep a live connection to Intiface with exponential backoff. Runs in the
  // background so the MCP server still starts (and returns clear errors) when
  // Intiface is down (spec §7.5).
  const connectLoop = async (): Promise<void> => {
    let delay = 1_000;
    while (!shuttingDown) {
      try {
        await controller.connect();
        log(`connected to Intiface at ${config.intifaceUrl}`);
        return;
      } catch (e) {
        log(`${e instanceof Error ? e.message : String(e)} — retrying in ${delay}ms`);
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  };

  controller.onDisconnect(() => {
    if (shuttingDown) return;
    log("Intiface connection dropped — reconnecting");
    void connectLoop();
  });

  controller.onDeviceAdded((id, name) => log(`device connected: [${id}] ${name}`));
  controller.onDeviceRemoved((id, name) => {
    log(`device disconnected: [${id}] ${name} — clearing its safety timers`);
    safety.forgetDevice(id);
  });

  // Stop everything if the AI client disconnects (transport close).
  server.server.onclose = (): void => {
    void safety.shutdown();
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} — stopping all devices`);
    await safety.shutdown();
    await controller.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  void connectLoop();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio");
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
