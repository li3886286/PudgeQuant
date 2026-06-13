<!-- mcp-name: io.github.ProjectAILiberation/tactus -->

# Tactus

[![CI](https://github.com/ProjectAILiberation/tactus/actions/workflows/ci.yml/badge.svg)](https://github.com/ProjectAILiberation/tactus/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**A content-agnostic MCP server that lets any AI agent control intimate hardware through a clean, safe tool interface.**

Tactus is a thin, neutral control layer. It wraps [Buttplug](https://buttplug.io/) /
Intiface — so a single integration reaches 750+ devices across ~26 brands — and
exposes them to AI agents as Model Context Protocol (MCP) tools. It forwards
hardware control commands only. **It does not generate, host, or store any
content of any kind.**

- **Safety first.** Intensity clamping, an independent watchdog auto-stop, a
  one-call emergency stop, and fail-safe stop semantics are built in and on by
  default — this is the headline feature, not an afterthought.
- **One-line install.** `npx -y tactus-mcp`, no clone or build.
- **OS-agnostic.** Tactus never touches Bluetooth. Intiface owns the radio; we
  just talk to it over a local WebSocket.

> ⚠️ Adults only (18+, or the age of majority in your jurisdiction). For use
> only on devices you own and only with the consent of everyone involved.

---

## How it works

```
  AI client / agent           Tactus (this server)            Intiface Central
  (Claude Desktop,    MCP      - MCP server          WebSocket - holds BLE/USB
   Claude Code, your  ───────▶ - Buttplug client     ────────▶   - 750+ device
   own AI product)            - SAFETY LAYER          :12345      protocols
                                                                     │ BLE/USB
                                                                     ▼
                                                                🔵 your device
```

Everything runs locally on your machine. Tactus is a Buttplug client that
connects to a locally running Intiface Central/Engine at
`ws://127.0.0.1:12345`.

## Prerequisites

1. Install [Intiface Central](https://intiface.com/central/).
2. Open it and click **Start Server**.
3. Pair your device (or, for development, add a simulated device under
   **Devices → Manage Simulated Devices**).

## Install & configure

Tactus runs over stdio via `npx`. Add it to your MCP client config.

**Claude Desktop / Claude Code** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tactus": {
      "command": "npx",
      "args": ["-y", "tactus-mcp"],
      "env": { "MAX_INTENSITY": "1.0" }
    }
  }
}
```

The same `command`/`args` work for any MCP client that launches stdio servers
(Cursor, Cline, Continue, etc.).

## Tools

| Tool | Purpose |
|---|---|
| `list_devices` | List connected devices and their actuators |
| `scan_for_devices` | Scan for and return newly found devices |
| `get_battery` | Read battery level (0.0–1.0) |
| `vibrate` | Set vibration intensity (0.0–1.0) |
| `oscillate` | Set oscillation intensity (0.0–1.0) |
| `rotate` | Set rotation speed and direction |
| `linear` | Move a stroker to a position over a duration |
| `vibrate_pattern` | Play a timed, interruptible vibration pattern |
| `stop_device` | Stop one device |
| `stop_all` | Emergency stop — halt every device immediately |
| `server_status` | Report connection status to Intiface |

All intensities are normalized to `0.0–1.0`. Every tool returns both structured
data and human-readable text.

## Safety

The safety layer wraps every driving command and is on by default:

- **Intensity clamp** — requests are clamped to `MAX_INTENSITY`; the effective
  value is reported back, and out-of-range input is rejected with a clear error
  rather than silently coerced.
- **Watchdog auto-stop** — any continuous drive auto-stops after
  `MAX_CONTINUOUS_MS` (default 10 minutes) unless refreshed by a new command.
  This is an independent timer, not a check-on-next-call.
- **Stop on disconnect/exit** — if the AI client disconnects or the process is
  signalled, all devices stop. The watchdog is the hard backstop for hard kills.
- **Interruptible patterns** — patterns are time-scheduled so a single call
  never blocks the server; any stop preempts them instantly.
- **Rate limiting** — per-device command bursts are coalesced to protect BLE.
- **Fail-safe stop** — if a stop cannot be confirmed, Tactus retries rather than
  optimistically reporting success.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INTIFACE_URL` | `ws://127.0.0.1:12345` | Intiface WebSocket address |
| `MAX_INTENSITY` | `1.0` | Clamp ceiling for drive intensity (0.0–1.0) |
| `MAX_CONTINUOUS_MS` | `600000` | Watchdog auto-stop window |
| `SCAN_DEFAULT_MS` | `5000` | Default scan duration |
| `--allow-unsafe` | _off_ | Disables the intensity clamp (discouraged) |

## Troubleshooting

**"Intiface is not reachable at ws://127.0.0.1:12345"**
Start Intiface Central and click **Start Server** (the top status should read
"Engine running"). Tactus retries automatically with backoff, so once Intiface
is up the tools start working without restarting your MCP client.

**A device doesn't show up when scanning**
- Make sure it is powered on and awake (press a button to wake it), and **not
  already connected to its own phone app** — Bluetooth devices accept one host at
  a time, so close/disconnect the app first.
- On macOS, Intiface needs Bluetooth permission: **System Settings → Privacy &
  Security → Bluetooth → enable Intiface Central**, then quit and reopen Intiface
  (the permission only takes effect after a restart).
- Keep the device in range; out-of-range devices drop and disappear from
  `list_devices`.

**My computer sees the device over Bluetooth, but Intiface/Tactus doesn't**
The device's advertised Bluetooth name isn't in Buttplug's supported device
list (common for regional/rebranded SKUs). Support must be added **upstream in
[Buttplug](https://github.com/buttplugio/buttplug)** — Tactus deliberately adds
no per-device code and does not reverse-engineer devices.

**A command returns "Unknown device id"**
The device disconnected (e.g. out of range) and left the known set. Call
`scan_for_devices` / `list_devices` to reconnect and get its current id.

## Known limitations

- **Device coverage = whatever Buttplug supports.** Devices not present in
  Buttplug's device configuration cannot be controlled until added upstream.
- **Silent link degradation is not actively detected.** A dropped link that
  Intiface reports is handled (the device leaves `list_devices` and drive calls
  error clearly). But if a Bluetooth link degrades silently *without* Intiface
  noticing, commands may appear to succeed while the device is unresponsive —
  active liveness probing is not yet implemented.
- **Local only.** This package controls devices on the same machine via a local
  Intiface. Internet/remote control is out of scope here.

## Adding support for an unrecognized device

Using a device from a supported brand that doesn't show up? It often just
advertises a Bluetooth name (or regional SKU) that Buttplug hasn't catalogued
yet. Because Tactus wraps Buttplug, the fix belongs **upstream in Buttplug**, not
here — and for a same-brand device it's usually just adding a **name**, with no
reverse-engineering.

1. Find the device's advertised Bluetooth name (see Troubleshooting above).
2. In Intiface's user device configuration, add that name to the same brand's
   existing protocol and test whether it drives correctly.
3. If it works, contribute the name upstream to
   [buttplugio/buttplug](https://github.com/buttplugio/buttplug) so everyone
   benefits — and/or open an **"Unsupported device"** issue here and we'll help.

If a device only works under a protocol it doesn't truly match — or needs a
protocol Buttplug doesn't have — that would require reverse-engineering, which is
out of scope (see [CONTRIBUTING](CONTRIBUTING.md)).

---

## Trademarks

"Lovense", "We-Vibe", "Satisfyer", "Kiiroo", "Lelo", "The Handy", "Magic
Motion", "Svakom", and other device names are trademarks of their respective
owners. Tactus is an independent project and is **not** affiliated with,
endorsed by, sponsored by, or partnered with any device manufacturer. It is
described as *compatible with* these devices only in the factual sense that it
builds on the open-source Buttplug protocol library. No manufacturer logos are
used.

## Content generation — out of scope

This server forwards hardware control commands only. It does **not** generate,
synthesize, recommend, or produce any text, image, audio, or video content. The
calling AI agent is the sole content-generating party and is solely responsible
for any content it produces and for compliance with content obligations in its
jurisdiction.

## Acceptable use

Tactus is a neutral, content-agnostic hardware control layer. It does **not**
support, document, or assist with: use on devices you do not own or lack consent
to operate; use by or on minors; or any use violating applicable law in your
jurisdiction. These statements describe the scope of maintainer support and
documentation — they are **not** additional restrictions on the License, which
continues to govern all use, modification, and redistribution. Users are
independently responsible for evaluating their use against applicable law.

Tactus only uses device protocols already supported upstream by Buttplug. It
does **not** reverse-engineer unsupported devices and does **not** break any
device encryption or access control. It collects and transmits no personal or
usage data.

## Disclaimer

This software controls hardware you connect to it. Use it only on devices you
own and only with the consent of everyone involved. For adults only (18+, or the
age of majority in your jurisdiction).

This software is provided "AS IS", without warranty of any kind (see
[LICENSE](LICENSE)). The statements above are informational; they do not modify
the License, add warranties or duties of care, or transfer liability. The
License's no-warranty and limitation-of-liability terms continue to apply in
full.

## License

[Apache-2.0](LICENSE).
