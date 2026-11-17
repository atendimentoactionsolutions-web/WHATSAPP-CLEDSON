import Database from 'better-sqlite3';
import fs from 'node:fs';
import { proto } from '@whiskeysockets/baileys';

// Only outgoing messages: no full group chat archive and no media binaries.
export class DeliveryStore {
  constructor(filename) {
    this.db = new Database(filename);
    fs.chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 3000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        jid TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL,
        campaign TEXT, created INTEGER NOT NULL, submitted INTEGER,
        status INTEGER NOT NULL DEFAULT 1, uncertain INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(jid,id)
      );
      CREATE INDEX IF NOT EXISTS message_campaign ON messages(campaign,created);
      CREATE TABLE IF NOT EXISTS receipts (
        jid TEXT NOT NULL, id TEXT NOT NULL, participant TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, read_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(jid,id,participant),
        FOREIGN KEY(jid,id) REFERENCES messages(jid,id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS diagnostics (name TEXT PRIMARY KEY, count INTEGER NOT NULL);
    `);
  }
  save(msg, campaign = null) {
    if (!msg?.key?.fromMe || !msg.key.id || !msg.key.remoteJid || !msg.message) return;
    const bytes = Buffer.from(proto.Message.encode(msg.message).finish());
    this.db.prepare(`INSERT INTO messages(jid,id,payload,campaign,created) VALUES(?,?,?,?,?)
      ON CONFLICT(jid,id) DO UPDATE SET campaign=COALESCE(messages.campaign,excluded.campaign)`)
      .run(msg.key.remoteJid, msg.key.id, bytes, campaign, Date.now());
  }
  get(key, retry = false) {
    const row = this.db.prepare('SELECT payload FROM messages WHERE jid=? AND id=?').get(key?.remoteJid || '', key?.id || '');
    if (retry) {
      this.db.prepare(`INSERT INTO diagnostics VALUES(?,1) ON CONFLICT(name) DO UPDATE SET count=count+1`).run(row ? 'recoveryHits' : 'recoveryMisses');
      if (row) this.db.prepare('UPDATE messages SET retries=retries+1 WHERE jid=? AND id=?').run(key.remoteJid,key.id);
    }
    return row ? proto.Message.decode(row.payload) : undefined;
  }
  findCampaignMessage(campaign, jid) {
    if (!campaign?.startsWith('camp_')) return undefined;
    const row = this.db.prepare('SELECT id,submitted,payload FROM messages WHERE campaign=? AND jid=? ORDER BY created LIMIT 1').get(campaign,jid);
    return row ? { key: { remoteJid: jid, id: row.id, fromMe: true }, message: proto.Message.decode(row.payload), submitted: row.submitted } : undefined;
  }
  submitted(key) {
    this.db.prepare('UPDATE messages SET submitted=?, uncertain=0 WHERE jid=? AND id=?').run(Date.now(),key.remoteJid,key.id);
  }
  uncertain(key) {
    this.db.prepare('UPDATE messages SET uncertain=1 WHERE jid=? AND id=?').run(key.remoteJid,key.id);
  }
  update(key, status) {
    if (!Number.isInteger(status) || status < 0 || status > 5) return;
    this.db.prepare(`UPDATE messages SET status=CASE WHEN ?=0 AND status<3 THEN 0 ELSE MAX(status,?) END WHERE jid=? AND id=?`)
      .run(status,status,key.remoteJid || '',key.id || '');
  }
  receipt(key, receipt) {
    if (!receipt?.userJid || !(Number(receipt.receiptTimestamp) > 0 || Number(receipt.readTimestamp) > 0 || Number(receipt.playedTimestamp) > 0)) return;
    this.db.prepare(`INSERT INTO receipts(jid,id,participant,delivered,read_at)
      SELECT jid,id,?,?,? FROM messages WHERE jid=? AND id=?
      ON CONFLICT(jid,id,participant) DO UPDATE SET delivered=MAX(delivered,excluded.delivered),read_at=MAX(read_at,excluded.read_at)`)
      .run(receipt.userJid, Number(receipt.receiptTimestamp || receipt.readTimestamp || receipt.playedTimestamp), Number(receipt.readTimestamp || receipt.playedTimestamp || 0), key.remoteJid || '', key.id || '');
  }
  summary(campaign) {
    const row = this.db.prepare(`SELECT COUNT(*) tracked,
      COALESCE(SUM(confirmed),0) confirmed, COALESCE(SUM(NOT confirmed),0) unconfirmed,
      COALESCE(SUM(status=0),0) rejected, COALESCE(SUM(uncertain),0) uncertain,
      COALESCE(SUM(retries),0) recoveryRequests, COALESCE(SUM(retries>=5),0) repeatedRecovery,
      COALESCE(SUM(NOT confirmed AND created<?),0) overdue
      FROM (SELECT m.*, (EXISTS(SELECT 1 FROM receipts r WHERE r.jid=m.jid AND r.id=m.id)
        OR (m.jid NOT LIKE '%@g.us' AND m.status>=3)) AS confirmed
        FROM messages m WHERE campaign=?)`).get(Date.now()-120000, campaign || '');
    return { ...row, meaning: 'Confirmação em grupo significa pelo menos um participante; não todos.' };
  }
  diagnostics() { return Object.fromEntries(this.db.prepare('SELECT name,count FROM diagnostics').all().map(r=>[r.name,r.count])); }
  audit({ campaign = null, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const where = campaign ? 'WHERE m.campaign=?' : '';
    const params = campaign ? [campaign, safeLimit] : [safeLimit];
    const rows = this.db.prepare(`
      SELECT m.jid, m.id, m.campaign, m.created, m.submitted, m.status, m.uncertain, m.retries, m.payload,
        COUNT(DISTINCT CASE WHEN r.delivered > 0 THEN r.participant END) AS deliveredParticipants,
        COUNT(DISTINCT CASE WHEN r.read_at > 0 THEN r.participant END) AS readParticipants
      FROM messages m
      LEFT JOIN receipts r ON r.jid=m.jid AND r.id=m.id
      ${where}
      GROUP BY m.jid, m.id
      ORDER BY m.created DESC
      LIMIT ?
    `).all(...params);
    return {
      diagnostics: this.diagnostics(),
      items: rows.map(row => {
        const msg = proto.Message.decode(row.payload);
        const mediaType = msg?.imageMessage ? 'image' : msg?.videoMessage ? 'video' : msg?.documentMessage ? 'document' : 'text';
        const rawText = msg?.imageMessage?.caption || msg?.videoMessage?.caption || msg?.extendedTextMessage?.text || msg?.conversation || '';
        return {
          jid: row.jid,
          id: row.id,
          campaign: row.campaign,
          createdAt: new Date(row.created).toISOString(),
          submittedAt: row.submitted ? new Date(row.submitted).toISOString() : null,
          status: row.status,
          uncertain: !!row.uncertain,
          retries: row.retries,
          mediaType,
          hasImage: mediaType === 'image',
          preview: rawText.slice(0, 60),
          deliveredParticipants: row.deliveredParticipants || 0,
          readParticipants: row.readParticipants || 0,
        };
      }),
    };
  }
  prune(now = Date.now()) {
    this.db.prepare('DELETE FROM messages WHERE created < ?').run(now - 30*86400000);
    this.db.prepare('DELETE FROM messages WHERE rowid IN (SELECT rowid FROM messages ORDER BY created DESC LIMIT -1 OFFSET 50000)').run();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }
  close() { this.db.close(); }
}
