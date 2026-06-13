# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/). While the major version is `0`, the
public tool interface may still change between minor versions.

## [0.1.0] — unreleased

First feature-complete development version. Verified against the Intiface device
simulator and at least one real device.

### Added
- MCP server (stdio) wrapping Buttplug/Intiface as a content-agnostic control layer.
- Tools: `list_devices`, `scan_for_devices`, `get_battery`, `vibrate`, `oscillate`,
  `rotate`, `linear`, `vibrate_pattern`, `stop_device`, `stop_all`, `server_status`.
- Safety layer (on by default): intensity clamping with honest effective-value
  reporting, an independent per-device watchdog auto-stop, stop-preemptible
  patterns, per-device rate limiting, stop-on-disconnect/exit, and fail-safe
  stop semantics that retry rather than assume success.
- Server-side hard validation of pattern bounds and out-of-range input.
- Robust Intiface connection with exponential-backoff reconnect; the server never
  crashes when Intiface is unavailable and returns clear, actionable errors.
- Reacts to a device dropping (BLE link lost / out of range): logs the
  disconnect and clears that device's safety timers so no watchdog fires for a
  device that is gone. (Note: silent BLE degradation that Intiface does not
  detect is not yet actively probed — see known limitations.)
- Configuration via `INTIFACE_URL`, `MAX_INTENSITY`, `MAX_CONTINUOUS_MS`,
  `SCAN_DEFAULT_MS`, and a gated `--allow-unsafe` override.
- Apache-2.0 license, compliance/trademark/acceptable-use documentation, unit
  tests for the safety layer, and CI across Node 20/22/24.
