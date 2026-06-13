# Security Policy

## Supported versions

This project is pre-1.0 and moves quickly. Security fixes target the latest
released version on the `main` branch only.

## Reporting a vulnerability

Please report security issues **privately**, not in public issues.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and click **"Report a vulnerability"**. This creates a private advisory
visible only to the maintainer.

When reporting, please include:
- What the issue is and how to reproduce it.
- The impact, and the affected version/commit.

Because this software controls physical hardware, we are especially interested
in reports that affect the **safety layer**, for example:
- a way to bypass or disable the intensity clamp, the watchdog auto-stop, or the
  emergency `stop_all`;
- a path where a stop is reported as successful but the device does not stop;
- input that makes a single call run unbounded and block other calls (including
  stops).

## Scope

In scope: the Tactus server and its safety layer.

Out of scope: vulnerabilities in upstream dependencies (report those to
[Buttplug](https://github.com/buttplugio/buttplug) / Intiface or the relevant
project), and the behavior of devices themselves.

## Expectations

This is a small, best-effort project with no formal response SLA. We aim to
acknowledge valid reports and address confirmed safety issues promptly. Please
allow reasonable time for a fix before any public disclosure.
