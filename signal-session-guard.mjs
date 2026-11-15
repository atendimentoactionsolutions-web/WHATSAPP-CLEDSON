import signal from 'libsignal';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const version = require('libsignal/package.json').version;
const installed = Symbol.for('cledson.signal-session-guard');

// libsignal 6.0.0 mutates a session's ratchet and consumes message keys before
// verifying the MAC. When trying several candidate sessions, a failed candidate
// can therefore be damaged and persisted along with a later successful one.
// Keep the crypto and authentication checks unchanged; commit only on success.
if (version !== '6.0.0') throw new Error('Revalidate the session guard before changing libsignal versions.');
if (!signal.SessionCipher.prototype[installed]) {
  const decrypt = signal.SessionCipher.prototype.doDecryptWhisperMessage;
  signal.SessionCipher.prototype.doDecryptWhisperMessage = async function (data, session) {
    if (!session) return decrypt.call(this, data, session);
    const candidate = session.constructor.deserialize(session.serialize());
    const plaintext = await decrypt.call(this, data, candidate);
    // Preserve object identity: SessionRecord still references this entry.
    for (const name of Object.keys(session)) delete session[name];
    Object.assign(session, candidate);
    return plaintext;
  };
  Object.defineProperty(signal.SessionCipher.prototype, installed, { value: true });
}
