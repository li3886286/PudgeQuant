# Contributing to Tactus

Thanks for your interest. Tactus is a small, focused project with a deliberately
narrow scope. Please read this before opening a PR.

## Scope and principles

Tactus is a **content-agnostic hardware control layer**. These principles are
not negotiable and shape what we will and won't accept:

- **Tools only, zero content.** Tactus forwards hardware control commands. It
  does not generate, host, or store any content. PRs that add content features
  are out of scope and will be declined.
- **Safety is a feature, not an option.** The safety layer (intensity clamp,
  watchdog auto-stop, fail-safe stop, rate limiting, stop-preemptible patterns)
  is core. Driving features must go through it. PRs that weaken or bypass safety
  by default will not be merged.
- **We do not reverse-engineer devices or break encryption.** Tactus only uses
  device protocols already supported upstream by [Buttplug](https://buttplug.io/).
  See "Adding device support" below.

## Adding device support

We do **not** add per-device or per-brand code here — Tactus wraps Buttplug, so
the device matrix comes from Buttplug. If a device isn't recognized:

- Add it upstream in
  [`buttplugio/buttplug`](https://github.com/buttplugio/buttplug) (the device
  configuration), not here. That benefits the whole ecosystem.
- Only contribute support that uses a device's existing, upstream-known protocol.
  Do not submit reverse-engineered protocols or decryption of access controls.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

To exercise the real Buttplug wire path, run Intiface Central, click **Start
Server**, add a simulated device under **Devices → Manage Simulated Devices**,
then:

```bash
npm run m0   # connect → scan → vibrate → stop against the simulator
```

## Pull requests

- Keep modules focused; prefer small, single-purpose files.
- Add or update tests for behavior changes — the safety layer especially.
- Describe what you changed and how you verified it (simulator and/or real device).
- Be honest about capabilities. Don't claim device support that isn't verified.

## Releases

Publishing to npm and the MCP registry, tagging releases, and changing repository
visibility are maintainer decisions and are not performed automatically.
