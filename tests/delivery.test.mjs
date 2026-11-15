import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DeliveryStore } from '../delivery-store.mjs';
import { reliableSend } from '../reliable-send.mjs';
import { generateWAMessage } from '@whiskeysockets/baileys';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cledson-test-'));
  const file = path.join(dir,'delivery.sqlite');
  const store = new DeliveryStore(file);
  t.after(()=>{ if(store.db.open) store.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  return {store,file};
}
const msg = (id='m1',jid='123@g.us') => ({key:{fromMe:true,id,remoteJid:jid},message:{imageMessage:{caption:'Oferta',mediaKey:Buffer.from([1,2,3]),fileSha256:Buffer.from([4,5,6]),url:'https://example.invalid/media'}}});

test('exact media protobuf survives process/store restart; getMessage does not invent missing messages',t=>{
  const {store,file}=setup(t);const m=msg();store.save(m,'camp_1');store.close();
  const next=new DeliveryStore(file);
  assert.equal(next.get(m.key).imageMessage.caption,'Oferta');
  assert.deepEqual(Buffer.from(next.get(m.key).imageMessage.mediaKey),Buffer.from([1,2,3]));
  assert.equal(next.get({...m.key,remoteJid:'other@g.us'},true),undefined);
  assert.equal(next.diagnostics().recoveryMisses,1);next.close();
});
test('server acknowledgement and group status never count as participant receipts',t=>{
  const {store}=setup(t);const m=msg();store.save(m,'camp_1');store.submitted(m.key);store.update(m.key,4);
  assert.equal(store.summary('camp_1').confirmed,0);
  store.receipt(m.key,{userJid:'a@s.whatsapp.net',receiptTimestamp:123});
  store.receipt(m.key,{userJid:'a@s.whatsapp.net',receiptTimestamp:123});
  assert.equal(store.summary('camp_1').confirmed,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM receipts').get().n,1);
});
test('read receipts imply delivery; missing and pending receipts do not',t=>{
  const {store}=setup(t);const m=msg();store.save(m,'camp_1');
  store.receipt(m.key,{userJid:'a@s.whatsapp.net'});assert.equal(store.summary('camp_1').confirmed,0);
  store.receipt(m.key,{userJid:'a@s.whatsapp.net',readTimestamp:123});assert.equal(store.summary('camp_1').confirmed,1);
});
test('incoming messages not archived; pruning removes associated receipts',t=>{
  const {store}=setup(t);store.save({...msg(),key:{...msg().key,fromMe:false}},'camp_1');
  assert.equal(store.summary('camp_1').tracked,0);
  store.save(msg(),'camp_1');store.receipt(msg().key,{userJid:'a',receiptTimestamp:123});
  store.prune(Date.now()+31*86400000);assert.equal(store.summary('camp_1').tracked,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM receipts').get().n,0);
});
test('three old unconfirmed group messages are visible to safety gate',t=>{
  const {store}=setup(t);for(let i=0;i<3;i++)store.save(msg('m'+i),'camp_1');
  store.db.prepare('UPDATE messages SET created=?').run(Date.now()-121000);
  assert.equal(store.summary('camp_1').overdue,3);
  store.receipt(msg().key,{userJid:'a',receiptTimestamp:123});assert.equal(store.summary('camp_1').overdue,2);
});
test('relay sees durable payload before sending and refreshes device discovery',async t=>{
  const {store}=setup(t);let calls=0,prepared=false;
  const socket={relayMessage:async(jid,content,options)=>{
    calls++;assert.equal(prepared,true);assert.ok(store.get({remoteJid:jid,id:options.messageId}));
    assert.equal(options.useUserDevicesCache,false);assert.equal(options.useCachedGroupMetadata,false);
    store.receipt({remoteJid:jid,id:options.messageId},{userJid:'a',receiptTimestamp:123});
  }};
  const args={store,socket,jid:'123@g.us',content:{},campaign:'camp_1',generate:async()=>msg(),prepareGroup:async()=>{prepared=true;}};
  await reliableSend(args);await reliableSend(args);assert.equal(calls,1);
  assert.equal(store.summary('camp_1').confirmed,1);
});
test('ambiguous relay failure is never retried under a new id, including after restart',async t=>{
  const {store,file}=setup(t);let calls=0;
  const args={store,socket:{relayMessage:async()=>{calls++;throw Error('Connection Closed');}},jid:'123@g.us',content:{},campaign:'camp_1',generate:async()=>msg(),prepareGroup:async()=>{}};
  await assert.rejects(reliableSend(args),{deliveryUncertain:true});store.close();
  const next=new DeliveryStore(file);await assert.rejects(reliableSend({...args,store:next}),{deliveryUncertain:true});
  assert.equal(calls,1);assert.equal(next.summary('camp_1').uncertain,1);next.close();
});
test('storage failure prevents any network relay',async()=>{
  let calls=0;
  await assert.rejects(reliableSend({store:{findCampaignMessage:()=>null,save:()=>{throw Error('disk full');}},socket:{relayMessage:async()=>{calls++;}},jid:'self@s.whatsapp.net',content:{},generate:async()=>msg()}),{storageFailure:true});
  assert.equal(calls,0);
});
test('real Baileys text generation preserves content without contacting WhatsApp',async()=>{
  const m=await generateWAMessage('123@s.whatsapp.net',{text:'Teste local'},{userJid:'456@s.whatsapp.net',messageId:'LOCAL_TEST'});
  assert.equal(m.key.id,'LOCAL_TEST');assert.equal(m.key.fromMe,true);
  assert.equal(m.message.extendedTextMessage?.text || m.message.conversation,'Teste local');
});
test('embedded dashboard scripts remain syntactically valid after template rendering',()=>{
  const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('res.send(`');assert.ok(start>=0);
  const end=source.indexOf('`);',start+10);
  const template=source.slice(start+9,end+1);
  const html=vm.runInNewContext(template);
  for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
test('sending a stored ad targets only the explicitly requested number and preserves image/caption',async()=>{
  const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('app.post("/send",');const end=source.indexOf('\napp.listen',start);
  let handler;const calls=[];
  vm.runInNewContext(source.slice(start,end),{
    app:{post:(route,fn)=>{handler=fn;}},API_SECRET:'test',waStatus:'CONNECTED',waSocket:{},
    appAds:[{id:'ad_33',caption:'Texto original',imageBase64:'stored-image'}],
    parseImageData:(value)=>{assert.equal(value,'stored-image');return {buffer:Buffer.from([1,2,3]),mime:'image/jpeg'};},
    sendTrackedMessage:async(socket,jid,content)=>{calls.push({jid,content});return {key:{id:'test-id'}};},
    saveMessageToStore:()=>{},
  });
  const req={headers:{},query:{},body:{jid:'5511930089729@s.whatsapp.net',adId:'ad_33'}};
  const res={code:200,status(n){this.code=n;return this;},json(value){this.value=value;return this;}};
  await handler(req,res);
  assert.equal(calls.length,1);assert.equal(calls[0].jid,req.body.jid);
  assert.equal(calls[0].content.caption,'Texto original');assert.deepEqual(calls[0].content.image,Buffer.from([1,2,3]));
  assert.equal(res.value.delivery,'unconfirmed');
  await handler({...req,body:{...req.body,adId:'missing'}},res);
  assert.equal(res.code,404);assert.equal(calls.length,1);
  await handler({...req,body:{adId:'ad_33'}},res);
  assert.equal(res.code,400);assert.equal(calls.length,1);
});
test('internal audit reports media type, delivery/read participant counts, and retries per group',t=>{
  const {store}=setup(t);
  const m=msg('m_img','group1@g.us');
  store.save(m,'camp_audit');store.submitted(m.key);
  store.receipt(m.key,{userJid:'p1@s.whatsapp.net',receiptTimestamp:1000});
  store.receipt(m.key,{userJid:'p2@s.whatsapp.net',receiptTimestamp:1001,readTimestamp:1002});
  store.get(m.key,true);
  const audit=store.audit({campaign:'camp_audit'});
  assert.equal(audit.items.length,1);
  assert.equal(audit.items[0].hasImage,true);
  assert.equal(audit.items[0].mediaType,'image');
  assert.equal(audit.items[0].preview,'Oferta');
  assert.equal(audit.items[0].deliveredParticipants,2);
  assert.equal(audit.items[0].readParticipants,1);
  assert.equal(audit.items[0].retries,1);
});
