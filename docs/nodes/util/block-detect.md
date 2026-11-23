---
title: "Block Detect"
description: "Event loop watchdog that detects blocking operations and alerts when Node-RED becomes sluggish for @rosepetal/node-red-contrib-utils."
head:
  - - meta
    - name: "keywords"
      content: "event loop, block, watchdog, monitor, performance, latency, node-red, rosepetal"
  - - meta
    - property: "og:title"
      content: "Block Detect - @rosepetal/node-red-contrib-utils"
  - - meta
    - property: "og:description"
      content: "Event loop watchdog that detects blocking operations and alerts when Node-RED becomes sluggish"
---

# Block Detect Node

## Purpose & Use Cases

The `block-detect` node gives you a lightweight watchdog that keeps an eye on Node-RED's event loop. When long running synchronous work or runaway CPU usage blocks the event loop, flows become sluggish, timers fire late, and HTTP endpoints stall. Dropping this node anywhere in your workspace makes it easy to detect those situations without wiring any messages.

**Typical scenarios**

- **Production health checks** &mdash; raise a warning in the runtime log when flows or custom code keep the event loop busy for too long.
- **Profiling new nodes** &mdash; temporarily add the node next to experimental flows to confirm they remain non-blocking.
- **Shared environments** &mdash; monitor collaborative / multi-tenant Node-RED instances for noisy neighbours that block everyone else.

## How It Works

- The node samples the Node.js [`monitorEventLoopDelay`](https://nodejs.org/api/perf_hooks.html#perf_hooks_monitor_event_loop_delay_options) histogram every *N* milliseconds (default one second). Each sample reads the maximum, mean and minimum delay recorded since the previous sample, then resets the histogram.
- When the maximum delay reaches the configured threshold for a number of consecutive samples, the node writes a warning to the runtime log.
- If `monitorEventLoopDelay` is unavailable, it logs `monitorEventLoopDelay not available; falling back to coarse timer drift detection.` and measures how late its own timer fires instead.
- A cooldown timer prevents log flooding when the system stays blocked for longer periods.

## Configuration

| Option | Description |
|--------|-------------|
| **Threshold (ms)** | Maximum acceptable event loop delay. Samples whose maximum delay reaches this value count as "blocking". Default: `120 ms`, minimum `1`. |
| **Sample interval (ms)** | How often to collect a measurement. Smaller values react faster but use slightly more CPU. Default: `1000 ms`, minimum `100`. |
| **Consecutive hits** | Number of back-to-back samples that must reach the threshold before an alert fires. Helps filter out one-off spikes. Default: `1`, minimum `1`. |
| **Cooldown (ms)** | Minimum time between alerts so your logs do not get spammed while a problem persists. Default: `30,000 ms`, minimum `1000`. |
| **Show live delay metrics** | When enabled (default) the node's status displays the latest average and max delay so you can watch it in real time. |

The node has no inputs or outputs and can sit anywhere in your flow.

> The watchdog internally samples `monitorEventLoopDelay` with a medium (20&nbsp;ms) resolution, which provides enough fidelity for alerts while keeping CPU overhead negligible.

Alerts are always emitted with `node.warn(...)` so they appear in the standard Node-RED log (and the debug sidebar) without additional configuration:

```
Detected potential blocking: max 312.5 ms (avg 48.2 ms, min 20.1 ms, threshold 120 ms).
```

When Consecutive hits is reached during the cooldown, no warning is written and the count starts again.

## Interpreting the Status

The status follows the last sample only; Consecutive hits and Cooldown apply to the log warning, not to the status.

- **Grey ring** `monitoring…` &mdash; Until the first sample.
- **Green dot** &mdash; Event loop delay is within the safe range: `avg 20.3ms | max 21.4ms` with *Show live delay metrics* on, `ok` with it off.
- **Red ring** `avg 48.2ms | max 312.5ms` (metrics on) or **red dot** `blocking detected` (metrics off) &mdash; The last sample reached the threshold. Check the runtime log for the alerts.

## Example

To be told about sustained blocking, not single spikes: Threshold `200`, Sample interval `1000`, Consecutive hits `3`, Cooldown `60000`. The node warns when three samples in a row (about three seconds) each saw a delay of 200 ms or more, and at most once a minute while that lasts.

## Tips

- Run multiple watchdogs with different thresholds (for example *120&nbsp;ms* and *500&nbsp;ms*) if you want layered alerting.
- Pair the node with system level monitoring (CPU, memory) to quickly confirm whether the blocking originated from Node-RED or external processes.
- Because the watchdog is passive and does not emit messages, it is safe to leave it deployed permanently even in large workspaces.
