import test from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { createRetryGuardCache, createNoopPlaceholderCache, attachBaileysStabilityGuard, shouldAckIncomingGroupMessage, PARSING_ERROR_NACK } from '../baileys-stability-guard.mjs';

test('exhausted incoming message retry triggers ParsingError nack (487) and prevents retry loops', async () => {
  const ws = new EventEmitter();
  const ev = new EventEmitter();
  ev.isBuffering = () => false;
  ev.flush = () => false;

  const acks = [];
  const sock = {
    ws,
    ev,
    sendMessageAck: async (node, code) => {
      acks.push({ id: node.attrs.id, code });
    },
  };

  const retryCache = createRetryGuardCache({ maxRetries: 5 });
  const guard = attachBaileysStabilityGuard({ sock, retryCache, flushIntervalMs: 0 });

  const node = { tag: 'message', attrs: { id: 'A51642E5', from: '123@lid' }, content: [] };
  ws.emit('CB:message', node);

  const key = 'A51642E5:undefined';
  retryCache.set(key, 5);
  assert.equal(retryCache.get(key), 5);
  retryCache.del(key);

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(acks, [{ id: 'A51642E5', code: PARSING_ERROR_NACK }]);
  assert.equal(retryCache.hasExhausted(key), true);
  assert.equal(retryCache.get(key), 5);
  assert.equal(guard.stats.exhaustedNacksSent, 1);

  guard.stop();
});

test('stuck Baileys event buffer is flushed on consecutive buffering ticks and delivers queued receipts/updates', async () => {
  await import('@whiskeysockets/baileys');
  const { makeEventBuffer } = await import('@whiskeysockets/baileys/lib/Utils/event-buffer.js');
  const ev = makeEventBuffer({ debug: () => {}, trace: () => {}, warn: () => {}, error: () => {} });

  const receivedReceipts = [];
  const receivedUpdates = [];
  ev.on('message-receipt.update', (u) => receivedReceipts.push(...u));
  ev.on('messages.update', (u) => receivedUpdates.push(...u));

  const sock = { ws: new EventEmitter(), ev };
  const retryCache = createRetryGuardCache();
  const guard = attachBaileysStabilityGuard({ sock, retryCache, flushIntervalMs: 0 });

  // Simulate Baileys createBufferedFunction leaving buffer open
  const bufferedFn = ev.createBufferedFunction(async () => {});
  await bufferedFn();
  assert.equal(ev.isBuffering(), true);

  ev.emit('messages.update', [{ key: { remoteJid: 'g1@g.us', id: 'm1', fromMe: true }, update: { status: 0 } }]);
  ev.emit('message-receipt.update', [{ key: { remoteJid: 'g1@g.us', id: 'm1', fromMe: true }, receipt: { userJid: 'u1@lid', receiptTimestamp: 123 } }]);
  assert.equal(receivedUpdates.length, 0);
  assert.equal(receivedReceipts.length, 0);

  // First tick notes buffering=true; second consecutive tick flushes stuck buffer
  assert.equal(guard.checkBuffer(), false);
  assert.equal(guard.checkBuffer(), true);

  assert.equal(ev.isBuffering(), false);
  assert.equal(receivedUpdates.length, 1);
  assert.equal(receivedReceipts.length, 1);
  assert.equal(guard.stats.forcedBufferFlushes, 1);

  ev.emit('connection.update', { connection: 'close' });
  assert.equal(guard.checkBuffer(), false);
});

test('noop placeholder cache short-circuits 5s resend delays without breaking cache contract', () => {
  const cache = createNoopPlaceholderCache();
  assert.equal(cache.get('any-id'), true);
  assert.equal(cache.set('any-id', true), true);
  assert.equal(cache.del('any-id'), 1);
  assert.doesNotThrow(() => cache.flushAll());
});

test('incoming group messages from other participants are acked immediately without entering decrypt queue', async () => {
  const ws = new EventEmitter();
  const ev = new EventEmitter();
  ev.isBuffering = () => false;
  ev.flush = () => false;

  const forwarded = [];
  ws.on('CB:message', (node) => forwarded.push(node.attrs.id));

  const receipts = [];
  const sock = {
    ws,
    ev,
    user: { id: '5511930089729:12@s.whatsapp.net', lid: '252440997834971:12@lid' },
    sendReceipt: async (jid, participant, ids, type) => { receipts.push({ jid, participant, ids, type }); },
  };
  const retryCache = createRetryGuardCache({ maxRetries: 2 });
  const guard = attachBaileysStabilityGuard({ sock, retryCache, flushIntervalMs: 0 });

  // Other participant in group -> receipted as inactive immediately, NOT forwarded to decrypt
  ws.emit('CB:message', { tag: 'message', attrs: { id: 'GRP_OTHER', from: '123@g.us', participant: '999@lid', type: 'media' } });
  // Own message in group (via lid or participant_pn) -> forwarded normally
  ws.emit('CB:message', { tag: 'message', attrs: { id: 'GRP_SELF_LID', from: '123@g.us', participant: '252440997834971:39@lid' } });
  ws.emit('CB:message', { tag: 'message', attrs: { id: 'GRP_SELF_PN', from: '123@g.us', participant: 'other@lid', participant_pn: '5511930089729@s.whatsapp.net' } });
  // Direct 1-on-1 message -> forwarded normally
  ws.emit('CB:message', { tag: 'message', attrs: { id: 'DM_MSG', from: '5511999999999@s.whatsapp.net' } });

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(receipts, [{ jid: '123@g.us', participant: '999@lid', ids: ['GRP_OTHER'], type: 'inactive' }]);
  assert.deepEqual(forwarded, ['GRP_SELF_LID', 'GRP_SELF_PN', 'DM_MSG']);
  assert.equal(guard.stats.ignoredGroupMessagesAcked, 1);
  assert.equal(guard.stats.messagesReceived, 4);
  assert.equal(shouldAckIncomingGroupMessage({ tag: 'message', attrs: { from: '123@g.us', participant: '999@lid' } }, sock.user), true);

  guard.stop();
});
