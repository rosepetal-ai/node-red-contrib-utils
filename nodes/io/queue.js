/**
 * @file Node.js logic for the Queue node providing buffering and rate limiting.
 */

module.exports = function (RED) {
  function QueueNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    /* ────────────────────────────
       ░░ 1.  Read configuration ░░
       ──────────────────────────── */
    const parsedMax = parseInt(config.maxQueueSize, 10);
    const parsedInterval = parseInt(config.intervalMilliseconds, 10);
    const parsedTimeout = parseInt(config.timeout, 10);
    const parsedMode = config.mode;

    node.maxQueueSize = Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : 0;
    node.intervalMs =
      Number.isInteger(parsedInterval) && parsedInterval > 0 ? parsedInterval : 0;
    node.timeoutMs =
      Number.isInteger(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 0;

    node.mode =
      parsedMode === 'timeout' || parsedMode === 'queue-size'
        ? parsedMode
        : 'legacy';

    const useQueueLimit = node.mode !== 'timeout';
    const useTimeout = node.mode !== 'queue-size';

    /* ────────────────────────────
       ░░ 2.  Internal state      ░░
       ──────────────────────────── */
    const state = {
      queue: [],
      timer: null,
      lastSent: 0
    };

    setStatusIdle();

    /* ────────────────────────────
       ░░ 3.  Helper functions    ░░
       ──────────────────────────── */
    function setStatusIdle() {
      node.status({ fill: 'blue', shape: 'dot', text: 'Idle' });
    }

    function setStatusQueued() {
      node.status({
        fill: 'yellow',
        shape: 'dot',
        text: `Queued: ${state.queue.length}`
      });
    }

    function clearTimer() {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }

    function pruneExpired() {
      if (!useTimeout || node.timeoutMs <= 0 || state.queue.length === 0) {
        return 0;
      }

      const now = Date.now();
      const expiredEntries = [];

      while (state.queue.length > 0) {
        const oldest = state.queue[0];
        if (now - oldest.enqueuedAt >= node.timeoutMs) {
          expiredEntries.push(state.queue.shift());
        } else {
          break;
        }
      }

      if (expiredEntries.length > 0) {
        node.warn(`Queue node dropped ${expiredEntries.length} message(s) due to timeout.`);
        // Send expired messages to output 2 with metadata
        for (const entry of expiredEntries) {
          const droppedMsg = entry.msg;
          droppedMsg.meta = droppedMsg.meta || {};
          droppedMsg.meta.queueDropped = true;
          droppedMsg.meta.queueDropReason = 'timeout';
          droppedMsg.meta.queuedDuration = now - entry.enqueuedAt;
          droppedMsg.meta.queueTimeout = node.timeoutMs;
          node.send([null, droppedMsg]);
        }
      }

      return expiredEntries.length;
    }

    function scheduleNextSend() {
      clearTimer();

      pruneExpired();

      if (state.queue.length === 0) {
        setStatusIdle();
        return;
      }

      const now = Date.now();
      const elapsed = state.lastSent ? now - state.lastSent : Number.POSITIVE_INFINITY;
      let delay = 0;

      if (node.intervalMs > 0 && Number.isFinite(elapsed) && elapsed < node.intervalMs) {
        delay = node.intervalMs - elapsed;
      }

      const sendFn = () => {
        state.timer = null;
        attemptSend();
      };

      state.timer = setTimeout(sendFn, Math.max(delay, 0));

      setStatusQueued();
    }

    function attemptSend() {
      pruneExpired();

      if (state.queue.length === 0) {
        setStatusIdle();
        return;
      }

      const now = Date.now();
      const elapsed = state.lastSent ? now - state.lastSent : Number.POSITIVE_INFINITY;

      if (node.intervalMs > 0 && Number.isFinite(elapsed) && elapsed < node.intervalMs) {
        scheduleNextSend();
        return;
      }

      const entry = state.queue.shift();
      if (!entry) {
        scheduleNextSend();
        return;
      }

      state.lastSent = now;
      node.status({
        fill: 'green',
        shape: 'dot',
        text: `Sending (remaining ${state.queue.length})`
      });

      node.send([entry.msg, null]);
      scheduleNextSend();
    }

    /* ────────────────────────────
       ░░ 4.  Input handler       ░░
       ──────────────────────────── */
    node.on('input', function (msg, _send, done) {
      try {
        pruneExpired();

        if (
          useQueueLimit &&
          node.maxQueueSize > 0 &&
          state.queue.length >= node.maxQueueSize
        ) {
          node.warn(
            `Queue node at capacity (${node.maxQueueSize}). Incoming message dropped.`
          );
          // Send overflow message to output 2 with metadata
          msg.meta = msg.meta || {};
          msg.meta.queueDropped = true;
          msg.meta.queueDropReason = 'overflow';
          msg.meta.queueSize = state.queue.length;
          msg.meta.queueMaxSize = node.maxQueueSize;
          node.send([null, msg]);
          setStatusQueued();
          return done?.();
        }

        state.queue.push({ msg, enqueuedAt: Date.now() });
        setStatusQueued();
        attemptSend();
        done?.();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'Error' });
        done ? done(err) : node.error(err, msg);
      }
    });

    /* ────────────────────────────
       ░░ 5.  Cleanup             ░░
       ──────────────────────────── */
    node.on('close', function () {
      clearTimer();
      state.queue.length = 0;
      setStatusIdle();
    });
  }

  RED.nodes.registerType('rp-queue', QueueNode);
};
