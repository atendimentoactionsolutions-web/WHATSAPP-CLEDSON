// Runtime stability guards for Baileys 6.7.x:
// 1. Ack with NACK_REASONS.ParsingError (487) when incoming undecryptable messages
//    exhaust maxMsgRetryCount, preventing 50-minute <stream:error><ack/></stream:error>
//    disconnect loops and offline queue re-floods.
// 2. Unstick sock.ev.isBuffering() if createBufferedFunction / missed offline marker
//    leaves the event buffer open, ensuring messages.update and message-receipt.update
//    continue reaching DeliveryStore.

export const PARSING_ERROR_NACK = 487;

function extractJidUser(jid) {
  if (typeof jid !== 'string' || !jid) return '';
  const at = jid.indexOf('@');
  const left = at >= 0 ? jid.slice(0, at) : jid;
  const colon = left.indexOf(':');
  return colon >= 0 ? left.slice(0, colon) : left;
}

function isSameUserJid(a, b) {
  const ua = extractJidUser(a);
  const ub = extractJidUser(b);
  return Boolean(ua && ub && ua === ub);
}

// Other participants' incoming messages in hundreds of buy/sell groups are never
// read by this bot, yet decrypt failures leave them unacked in Baileys and clog
// WhatsApp's in-flight stanza window (stalling receipts and causing 50m stream errors).
// Receipts and customer retry requests arrive on CB:receipt, never CB:message.
export function shouldAckIncomingGroupMessage(node, user) {
  if (!node || node.tag !== 'message') return false;
  const from = node.attrs?.from;
  const participant = node.attrs?.participant;
  if (typeof from !== 'string' || !from.endsWith('@g.us') || !participant) return false;
  const myIds = [user?.id, user?.lid].filter(Boolean);
  const senderIds = [participant, node.attrs?.participant_pn].filter(Boolean);
  for (const me of myIds) {
    for (const sender of senderIds) {
      if (isSameUserJid(me, sender)) return false;
    }
  }
  return true;
}

// Prevents Baileys's requestPlaceholderResend from sleeping 5000ms per
// undecryptable/unavailable group message inside offlineNodeProcessor & retryMutex,
// which otherwise stalls receipt and customer-retry handling for 40+ minutes.
export function createNoopPlaceholderCache() {
  return {
    get: () => true,
    set: () => true,
    del: () => 1,
    flushAll: () => {},
  };
}

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
    ignoredGroupMessagesAcked: 0,
    offlinePreviews: 0,
    offlineBatchesRequested: 0,
    offlineCompleted: 0,
    lastOfflinePreview: null,
    receiptsReceived: 0,
    notificationsReceived: 0,
    messagesReceived: 0,
    lastForcedFlushAt: null,
    lastExhaustedNackAt: null,
  };

  let offlineInProgress = false;
  let lastOfflineActivityAt = 0;

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

  let originalMessageListeners = null;
  let wrappedMessageListener = null;
  const onOfflinePreview = (node) => {
    stats.offlinePreviews += 1;
    offlineInProgress = true;
    lastOfflineActivityAt = Date.now();
    const previewChild = Array.isArray(node?.content)
      ? node.content.find((c) => c?.tag === 'offline_preview')
      : null;
    if (previewChild?.attrs) stats.lastOfflinePreview = { ...previewChild.attrs };
  };
  const onOfflineComplete = () => {
    stats.offlineCompleted += 1;
    offlineInProgress = false;
  };
  const onReceipt = () => {
    stats.receiptsReceived += 1;
    if (offlineInProgress) lastOfflineActivityAt = Date.now();
  };
  const onNotification = () => {
    stats.notificationsReceived += 1;
    if (offlineInProgress) lastOfflineActivityAt = Date.now();
  };

  if (sock.ws && typeof sock.ws.on === 'function') {
    sock.ws.on('CB:ib,,offline_preview', onOfflinePreview);
    sock.ws.on('CB:ib,,offline', onOfflineComplete);
    sock.ws.on('CB:receipt', onReceipt);
    sock.ws.on('CB:notification', onNotification);
    if (typeof sock.ws.listeners === 'function' && typeof sock.ws.removeAllListeners === 'function') {
      originalMessageListeners = sock.ws.listeners('CB:message').slice();
      sock.ws.removeAllListeners('CB:message');
      wrappedMessageListener = (node) => {
        stats.messagesReceived += 1;
        if (offlineInProgress) lastOfflineActivityAt = Date.now();
        const me = sock.user || sock.authState?.creds?.me;
        if (shouldAckIncomingGroupMessage(node, me)) {
          const ackPromise = typeof sock.sendReceipt === 'function'
            ? sock.sendReceipt(node.attrs.from, node.attrs.participant, [node.attrs.id], 'inactive')
            : (typeof sock.sendMessageAck === 'function' ? sock.sendMessageAck(node, PARSING_ERROR_NACK) : Promise.resolve());
          Promise.resolve(ackPromise)
            .then(() => {
              stats.ignoredGroupMessagesAcked += 1;
            })
            .catch(() => {});
          return;
        }
        trackNode(node);
        for (const fn of originalMessageListeners) fn.call(sock.ws, node);
      };
      sock.ws.on('CB:message', wrappedMessageListener);
    } else {
      sock.ws.on('CB:message', trackNode);
    }
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

  const pumpOfflineBatch = (now = Date.now(), idleMs = 2000) => {
    if (stopped || !offlineInProgress || typeof sock.sendNode !== 'function') return false;
    if (sock.ws && sock.ws.isOpen === false) return false;
    if (now - lastOfflineActivityAt < idleMs) return false;
    lastOfflineActivityAt = now;
    stats.offlineBatchesRequested += 1;
    Promise.resolve(
      sock.sendNode({
        tag: 'ib',
        attrs: {},
        content: [{ tag: 'offline_batch', attrs: { count: '100' } }],
      })
    ).catch(() => {});
    return true;
  };

  const checkBuffer = () => {
    if (stopped) return false;
    pumpOfflineBatch();
    if (!sock.ev || typeof sock.ev.isBuffering !== 'function') return false;
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

  const timer = flushIntervalMs > 0 ? setInterval(checkBuffer, Math.min(flushIntervalMs, 2500)) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (sock.ws && typeof sock.ws.off === 'function') {
      sock.ws.off('CB:ib,,offline_preview', onOfflinePreview);
      sock.ws.off('CB:ib,,offline', onOfflineComplete);
      sock.ws.off('CB:receipt', onReceipt);
      sock.ws.off('CB:notification', onNotification);
      if (wrappedMessageListener) {
        sock.ws.off('CB:message', wrappedMessageListener);
      } else {
        sock.ws.off('CB:message', trackNode);
      }
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

  return { checkBuffer, pumpOfflineBatch, stop, stats, handleExhaustedKey };
}
