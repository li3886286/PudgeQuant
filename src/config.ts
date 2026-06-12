import { TactusConfig } from "./types.js";

const DEFAULT_INTIFACE_URL = "ws://127.0.0.1:12345";
const DEFAULT_MAX_INTENSITY = 1.0;
const DEFAULT_MAX_CONTINUOUS_MS = 600_000; // 10 minutes
const DEFAULT_SCAN_MS = 5_000;
const MAX_COMMANDS_PER_SEC = 20;
const MAX_PATTERN_STEPS = 200;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${name}="${raw}": expected a number`);
  }
  return n;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Build runtime config from environment variables and CLI flags.
 * Safety defaults (clamp on, 10-min watchdog) are intentional — see spec §7.4.
 */
export function loadConfig(argv: readonly string[] = process.argv.slice(2)): TactusConfig {
  const allowUnsafe =
    argv.includes("--allow-unsafe") || process.env.TACTUS_ALLOW_UNSAFE === "1";

  // The unsafe override opens the clamp ceiling to the full range.
  const maxIntensity = allowUnsafe
    ? 1.0
    : clamp01(numEnv("MAX_INTENSITY", DEFAULT_MAX_INTENSITY));

  return {
    intifaceUrl: process.env.INTIFACE_URL?.trim() || DEFAULT_INTIFACE_URL,
    maxIntensity,
    maxContinuousMs: numEnv("MAX_CONTINUOUS_MS", DEFAULT_MAX_CONTINUOUS_MS),
    scanDefaultMs: numEnv("SCAN_DEFAULT_MS", DEFAULT_SCAN_MS),
    maxCommandsPerSec: MAX_COMMANDS_PER_SEC,
    maxPatternSteps: MAX_PATTERN_STEPS,
    allowUnsafe,
  };
}
