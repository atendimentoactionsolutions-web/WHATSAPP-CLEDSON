import test from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { createRetryGuardCache, attachBaileysStabilityGuard, PARSING_ERROR_NACK } from '../baileys-stability-guard.mjs';

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
