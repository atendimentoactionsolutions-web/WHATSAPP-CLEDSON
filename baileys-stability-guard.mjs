// Runtime stability guards for Baileys 6.7.x:
// 1. Ack with NACK_REASONS.ParsingError (487) when incoming undecryptable messages
//    exhaust maxMsgRetryCount, preventing 50-minute <stream:error><ack/></stream:error>
//    disconnect loops and offline queue re-floods.
// 2. Unstick sock.ev.isBuffering() if createBufferedFunction / missed offline marker
//    leaves the event buffer open, ensuring messages.update and message-receipt.update
//    continue reaching DeliveryStore.

export const PARSING_ERROR_NACK = 487;

export function createRetryGuardCache({ maxRetries = 5, maxSize = 5000, maxExhausted = 2000 } = {}) {
  const map = new Map();
  const exhausted = new Set();
  let onExhausted = null;

  return {
    setOnExhausted(fn) {
      onExhausted = typeof fn === 'function' ? fn : null;
    },
    get(k) {
      if (exhausted.has(k)) return maxRetries;
      return map.get(k);
    },
    set(k, v) {
      if (exhausted.has(k) && v < maxRetries) exhausted.delete(k);
      map.set(k, v);
      if (map.size > maxSize) {
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) map.delete(firstKey);
      }
      return true;
    },
    del(k) {
      const existed = map.delete(k);
      exhausted.add(k);
      if (exhausted.size > maxExhausted) {
        const first = exhausted.values().next().value;
        if (first !== undefined) exhausted.delete(first);
      }
      if (onExhausted) {
        try {
          onExhausted(k);
        } catch {}
      }
      return existed ? 1 : 0;
    },
    hasExhausted(k) {
      return exhausted.has(k);
    },
    flushAll() {
      map.clear();
      exhausted.clear();
    },
  };
}

export function attachBaileysStabilityGuard({
  sock,
  retryCache,
  logger = null,
  flushIntervalMs = 4000,
  maxTrackedNodes = 500,
} = {}) {
  if (!sock) throw new Error('sock is required');
  const recentMessageNodes = new Map();
  const stats = {
    forcedBufferFlushes: 0,
    exhaustedNacksSent: 0,
    lastForcedFlushAt: null,
    lastExhaustedNackAt: null,
  };

  const trackNode = (node) => {
    const id = node?.attrs?.id;
    if (!id) return;
    recentMessageNodes.set(id, {
      tag: node.tag || 'message',
      attrs: { ...node.attrs },
      content: node.content,
    });
    if (recentMessageNodes.size > maxTrackedNodes) {
      const firstId = recentMessageNodes.keys().next().value;
      if (firstId !== undefined) recentMessageNodes.delete(firstId);
    }
  };

  if (sock.ws && typeof sock.ws.on === 'function') {
    sock.ws.on('CB:message', trackNode);
  }

  const handleExhaustedKey = (cacheKey) => {
    const sep = String(cacheKey).indexOf(':');
    const msgId = sep >= 0 ? String(cacheKey).slice(0, sep) : String(cacheKey);
    const node = recentMessageNodes.get(msgId);
    if (!node || typeof sock.sendMessageAck !== 'function') return;
    recentMessageNodes.delete(msgId);
    Promise.resolve(sock.sendMessageAck(node, PARSING_ERROR_NACK))
      .then(() => {
        stats.exhaustedNacksSent += 1;
        stats.lastExhaustedNackAt = new Date().toISOString();
      })
      .catch(() => {});
  };

  if (retryCache && typeof retryCache.setOnExhausted === 'function') {
    retryCache.setOnExhausted(handleExhaustedKey);
  }

  let wasBuffering = false;
  let stopped = false;

  const checkBuffer = () => {
    if (stopped || !sock.ev || typeof sock.ev.isBuffering !== 'function') return false;
    const buffering = !!sock.ev.isBuffering();
    if (buffering && wasBuffering) {
      try {
        sock.ev.flush();
        stats.forcedBufferFlushes += 1;
        stats.lastForcedFlushAt = new Date().toISOString();
        logger?.warn?.({ stats }, 'Flushed stuck Baileys event buffer');
      } catch {}
      wasBuffering = !!sock.ev.isBuffering();
      return true;
    }
    wasBuffering = buffering;
    return false;
  };

  const timer = flushIntervalMs > 0 ? setInterval(checkBuffer, flushIntervalMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (sock.ws && typeof sock.ws.off === 'function') {
      sock.ws.off('CB:message', trackNode);
    }
    if (retryCache && typeof retryCache.setOnExhausted === 'function') {
      retryCache.setOnExhausted(null);
    }
  };

  if (sock.ev && typeof sock.ev.on === 'function') {
    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'close') stop();
    });
  }

  return { checkBuffer, stop, stats, handleExhaustedKey };
}
