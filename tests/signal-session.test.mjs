import "../signal-session-guard.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import signal from 'libsignal';

function device() {
  const identity=signal.keyhelper.generateIdentityKeyPair();
  const registrationId=signal.keyhelper.generateRegistrationId();
  const signed=signal.keyhelper.generateSignedPreKey(identity,1);
  const pre=signal.keyhelper.generatePreKey(1);
  const records=new Map();
  return {
    bundle:{identityKey:identity.pubKey,registrationId,signedPreKey:{keyId:1,publicKey:signed.keyPair.pubKey,signature:signed.signature},preKey:{keyId:1,publicKey:pre.keyPair.pubKey}},
    store:{
      getOurIdentity:async()=>identity,getOurRegistrationId:async()=>registrationId,
      isTrustedIdentity:async()=>true,loadSignedPreKey:async()=>signed.keyPair,loadPreKey:async()=>pre.keyPair,removePreKey:async()=>{},
      loadSession:async id=>records.has(id)?signal.SessionRecord.deserialize(records.get(id)):undefined,
      storeSession:async(id,record)=>records.set(id,record.serialize()),
    },
  };
}
async function paired() {
  const alice=device(),bob=device();
  const aAddr=new signal.ProtocolAddress('alice',1), bAddr=new signal.ProtocolAddress('bob',1);
  await new signal.SessionBuilder(alice.store,bAddr).initOutgoing(bob.bundle);
  const a=new signal.SessionCipher(alice.store,bAddr),b=new signal.SessionCipher(bob.store,aAddr);
  const hello=await a.encrypt(Buffer.from('hello'));
  assert.equal((await b.decryptPreKeyWhisperMessage(Buffer.from(hello.body))).toString(),'hello');
  const reply=await b.encrypt(Buffer.from('reply'));
  assert.equal((await a.decryptWhisperMessage(Buffer.from(reply.body))).toString(),'reply');
  return {alice,bob,a,b,aAddr};
}

test('an unsuccessful real MAC check must not consume keys in another session candidate',async()=>{
  const {bob,a,b,aAddr}=await paired();
  const outgoing=await a.encrypt(Buffer.from('anuncio'));
  assert.equal(outgoing.type,1);
  const record=await bob.store.loadSession(aAddr.toString());
  const valid=record.getOpenSession();
  const wrong=valid.constructor.deserialize(valid.serialize());
  wrong.indexInfo.remoteIdentityKey=signal.keyhelper.generateIdentityKeyPair().pubKey;
  const before=wrong.serialize();
  const result=await b.decryptWithSessions(Buffer.from(outgoing.body),[wrong,valid]);
  assert.equal(result.plaintext.toString(),'anuncio');
  assert.deepEqual(wrong.serialize(),before,'failed session candidates must remain intact');
  assert.equal(result.session,valid,'successful ratchet changes must update the record entry');
});

test('tampered ciphertext is rejected and valid ciphertext still decrypts afterwards',async()=>{
  const {bob,a,b,aAddr}=await paired();
  const outgoing=await a.encrypt(Buffer.from('mensagem original'));
  const bytes=Buffer.from(outgoing.body);const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;
  const session=(await bob.store.loadSession(aAddr.toString())).getOpenSession();
  const before=session.serialize();
  await assert.rejects(b.doDecryptWhisperMessage(corrupt,session),/Bad MAC/);
  assert.deepEqual(session.serialize(),before);
  assert.equal((await b.doDecryptWhisperMessage(bytes,session)).toString(),'mensagem original');
  await assert.rejects(b.doDecryptWhisperMessage(bytes,session),/Key used already/);
});

test('group ciphertext is readable by independent recipients and recovers after missing sender-key distribution',async()=>{
  await import('@whiskeysockets/baileys');
  const {makeLibSignalRepository}=await import('@whiskeysockets/baileys/lib/Signal/libsignal.js');
  const repository=()=>{
    const values=new Map();
    return makeLibSignalRepository({creds:{},keys:{
      get:async(type,ids)=>Object.fromEntries(ids.map(id=>[id,values.get(type+':'+id)])),
      set:async(data)=>{for(const [type,items] of Object.entries(data))for(const [id,value] of Object.entries(items))values.set(type+':'+id,value);},
    }});
  };
  const sender=repository(),recipients=[repository(),repository(),repository()];
  const group='test-only@g.us',authorJid='12345@s.whatsapp.net';
  const message=await sender.encryptGroupMessage({group,meId:authorJid,data:Buffer.from('Imagem e legenda do anuncio')});
  await assert.rejects(recipients[2].decryptGroupMessage({group,authorJid,msg:message.ciphertext}),/No session/);
  for(const recipient of recipients) {
    await recipient.processSenderKeyDistributionMessage({authorJid,item:{groupId:group,axolotlSenderKeyDistributionMessage:message.senderKeyDistributionMessage}});
    const readable=await recipient.decryptGroupMessage({group,authorJid,msg:message.ciphertext});
    assert.equal(readable.toString(),'Imagem e legenda do anuncio');
  }
  const next=await sender.encryptGroupMessage({group,meId:authorJid,data:Buffer.from('Proxima mensagem')});
  for(const recipient of recipients)assert.equal((await recipient.decryptGroupMessage({group,authorJid,msg:next.ciphertext})).toString(),'Proxima mensagem');
});
