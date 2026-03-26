---
title: "Rate Limit"
description: "Enforce minimum intervals between messages using external timestamps for @rosepetal/node-red-contrib-utils."
head:
  - - meta
    - name: "keywords"
      content: "rate-limit, throttle, timestamp, interval, cadence, timing, node-red, rosepetal"
  - - meta
    - property: "og:title"
      content: "Rate Limit - @rosepetal/node-red-contrib-utils"
  - - meta
    - property: "og:description"
      content: "Enforce minimum intervals between messages using external timestamps"
---

# Rate Limit Node

## Purpose & Use Cases

The `rate-limit` node enforces a minimum interval between output messages based on external timestamps (from hardware, sensors, or other sources) rather than internal `Date.now()` timing. This makes rate decisions immune to event-loop drift and more accurate for real-time data streams.

**Typical scenarios:**
- Throttle high-frequency sensor or camera data to a manageable rate
- Deduplicate rapid-fire hardware triggers that arrive faster than processing can handle
- Control output cadence for downstream systems with rate constraints
- Monitor message timing statistics across a rolling window

## Input/Output Specification

### Inputs
- **Incoming Message**: Any Node-RED message containing a timestamp at the configured path.

### Outputs
- **Output 1 (passed)**: Messages that meet or exceed the minimum interval since the last accepted message. The first message always passes.
- **Output 2 (throttled)**: Messages that arrived sooner than the configured interval since the last accepted message.

Both outputs receive timing data at the configured output path (when set).

### Timing Data
```javascript
{
  timeBetween: number,      // ms since last accepted message (-1 for first message)
  avgTimeBetween: number,   // average ms between messages in the rolling window (rounded)
  messageCount: number      // number of messages currently in the rolling window
}
```

## Configuration Options

### Timestamp
- **Type**: Typed input (`msg` | `flow` | `global`)
- **Default**: `msg.timestamp`
- **Purpose**: Path to the external timestamp value. Accepts ISO 8601 strings, epoch milliseconds, or Date objects.

### Interval (ms)
- **Type**: Typed input (`num` | `msg` | `flow` | `global`)
- **Default**: `250`
- **Purpose**: Minimum milliseconds between passed messages. Messages arriving sooner are sent to the throttled output.

### Window (ms)
- **Type**: Typed input (`num` | `msg` | `flow` | `global`)
- **Default**: `5000`
- **Purpose**: Rolling time window for average cadence calculation. Messages older than this are dropped from the history.

### Output to
- **Type**: Typed input (`msg` | `flow` | `global`)
- **Default**: *(empty -- no timing data attached)*
- **Purpose**: Where to write the timing data object on each message.

## Behavior

- The first message always passes (timeBetween = -1).
- Subsequent messages pass only if the external timestamp difference from the last *accepted* message meets or exceeds the interval.
- All messages (passed and throttled) are added to the rolling window history for cadence calculation.
- The rolling window is pruned on each message to remove entries older than the window size.
- Invalid timestamps cause the message to be dropped with a warning.
- Invalid interval or window values cause the message to be dropped with a warning.
- Interval and window size can be set dynamically per-message when using `msg`, `flow`, or `global` types.

## Status

- **Blue dot** -- Idle, no messages received yet.
- **Green dot** -- Last message passed. Shows time since previous and rolling average.
- **Yellow dot** -- Last message was throttled. Shows the interval comparison.
- **Red ring** -- Error (invalid timestamp, interval, or window value).

## Example Flows

### Throttle Camera Frames
```
[Camera] → [Rate Limit: interval=100, timestamp=msg.captureTime] → [Process Frame]
```
Accept at most one frame every 100ms based on the camera's own capture timestamp.

### Monitor Sensor Cadence
```
[Sensor] → [Rate Limit: interval=0, output=msg.timing] → [Dashboard]
```
Pass all messages through (interval=0) while attaching rolling timing statistics for monitoring.
