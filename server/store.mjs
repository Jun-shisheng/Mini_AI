import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const now = () => new Date().toISOString();

/** Local encrypted conversation store. The key must be backed up with the database. */
export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, '.storage-key');
  let key;
  try { key = readFileSync(keyPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = randomBytes(32);
    try { writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      key = readFileSync(keyPath);
    }
  }
  if (key.length !== 32) throw new Error('会话存储密钥无效，请恢复 data/.storage-key 备份。');
  const databasePath = join(dataDir, 'companion.sqlite');
  const db = new DatabaseSync(databasePath);
  try { chmodSync(databasePath, 0o600); } catch { /* Windows uses ACLs. */ }
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS native_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversations_user_updated ON conversations(user_id,updated_at);
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT, message_id TEXT, request_id TEXT, mode TEXT NOT NULL, status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_hit_tokens INTEGER NOT NULL, cache_miss_tokens INTEGER NOT NULL,
      source TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_user_created ON usage(user_id,created_at);
    CREATE TABLE IF NOT EXISTS chat_requests (
      request_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL,
      status TEXT NOT NULL, input_characters INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,request_id)
    );
  `);
  if (!db.prepare('PRAGMA table_info(usage)').all().some((column) => column.name === 'request_id')) {
    db.exec('ALTER TABLE usage ADD COLUMN request_id TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS usage_request_id ON usage(user_id,request_id) WHERE request_id IS NOT NULL');
  db.exec(`CREATE INDEX IF NOT EXISTS usage_created_at ON usage(created_at);
    CREATE INDEX IF NOT EXISTS chat_requests_created_at ON chat_requests(created_at);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS native_sessions_expires_at ON native_sessions(expires_at);`);

  const encrypt = (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
  };
  const decrypt = (value) => {
    const [version, iv, tag, ciphertext] = value.split('.');
    if (version !== 'v1') throw new Error('Unsupported conversation encryption version');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  };
  const recordToConversation = (row) => row ? {
    ...decrypt(row.payload), id: row.id, createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;

  const store = {
    db,
    createUser(username, passwordHash) {
      const user = { id: randomUUID(), username, createdAt: now() };
      db.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)')
        .run(user.id, username, passwordHash, user.createdAt);
      return user;
    },
    findUser(username) { return db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username); },
    addSession(tokenHash, userId, expiresAt) {
      db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash, userId, expiresAt);
    },
    sessionUser(tokenHash) {
      const row = db.prepare(`SELECT users.id,users.username,users.created_at FROM sessions
        JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?`).get(tokenHash, Date.now());
      return row ? { id: row.id, username: row.username, createdAt: row.created_at } : null;
    },
    deleteSession(tokenHash) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); },
    addNativeSession(tokenHash, userId, expiresAt) {
      db.prepare('DELETE FROM native_sessions WHERE expires_at<=?').run(Date.now());
      db.prepare('INSERT INTO native_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
        .run(tokenHash, userId, expiresAt, now());
    },
    nativeSessionUser(tokenHash) {
      const row = db.prepare(`SELECT users.id,users.username,users.created_at FROM native_sessions
        JOIN users ON users.id=native_sessions.user_id WHERE token_hash=? AND expires_at>?`).get(tokenHash, Date.now());
      return row ? { id: row.id, username: row.username, createdAt: row.created_at } : null;
    },
    deleteNativeSession(tokenHash) { db.prepare('DELETE FROM native_sessions WHERE token_hash=?').run(tokenHash); },
    getConversation(id, userId) {
      return recordToConversation(db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId));
    },
    listConversations(userId) {
      return db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(userId)
        .map(recordToConversation).map(({ messages, ...conversation }) => ({
          ...conversation, messageCount: messages.length,
          preview: messages.filter((message) => message.role !== 'system').at(-1)?.content?.slice(0, 120) || '',
        }));
    },
    createConversation(userId, data) {
      const date = now();
      const conversation = { id: randomUUID(), title: data.title, persona: data.persona,
        messages: data.messages || [], createdAt: date, updatedAt: date };
      this.saveConversation(userId, conversation);
      return conversation;
    },
    saveConversation(userId, conversation) {
      const { id, createdAt, updatedAt, ...payload } = conversation;
      db.prepare(`INSERT INTO conversations(id,user_id,payload,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at WHERE conversations.user_id=excluded.user_id`)
        .run(id, userId, encrypt(payload), createdAt, updatedAt);
    },
    deleteConversation(id, userId) {
      return db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(id, userId).changes > 0;
    },
    importConversations(userId, conversations) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = conversations.map((conversation) => this.createConversation(userId, conversation));
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    addUsage(userId, data) {
      const entry = { id: randomUUID(), createdAt: now(), ...data };
      db.prepare(`INSERT INTO usage(id,user_id,conversation_id,message_id,request_id,mode,status,input_tokens,output_tokens,
        cache_hit_tokens,cache_miss_tokens,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(entry.id, userId, entry.conversationId, entry.messageId, entry.requestId || null, entry.mode, entry.status,
          entry.inputTokens, entry.outputTokens, entry.cacheHitTokens, entry.cacheMissTokens, entry.source, entry.createdAt);
      return entry;
    },
    beginChatRequest(userId, entry, metered = false) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const date = now();
        const used = db.prepare('SELECT 1 FROM usage WHERE user_id=? AND request_id=?').get(userId, entry.requestId);
        const inserted = !used && db.prepare(`INSERT OR IGNORE INTO chat_requests(request_id,user_id,conversation_id,message_id,mode,model,
          status,input_characters,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?,?)`)
          .run(entry.requestId, userId, entry.conversationId, entry.messageId, entry.mode, entry.model, entry.inputCharacters, date, date).changes > 0;
        db.exec('COMMIT');
        return inserted;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    chatRequest(userId, requestId) {
      const entry = db.prepare(`SELECT request_id AS requestId,conversation_id AS conversationId,message_id AS messageId,
        mode,model,status,created_at AS createdAt,updated_at AS updatedAt FROM chat_requests WHERE user_id=? AND request_id=?`)
        .get(userId, requestId);
      if (!entry) return null;
      const usage = db.prepare(`SELECT id,request_id AS requestId,conversation_id AS conversationId,message_id AS messageId,
        mode,status,input_tokens AS inputTokens,output_tokens AS outputTokens,cache_hit_tokens AS cacheHitTokens,
        cache_miss_tokens AS cacheMissTokens,source,created_at AS createdAt FROM usage WHERE user_id=? AND request_id=?`)
        .get(userId, requestId);
      return { ...entry, usage: usage || null };
    },
    finishChatRequest(userId, requestId, data, charge = false) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const usage = this.addUsage(userId, { ...data, requestId });
        db.prepare('UPDATE chat_requests SET status=?,updated_at=? WHERE user_id=? AND request_id=?')
          .run(data.status, now(), userId, requestId);
        db.exec('COMMIT');
        return usage;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    pruneMetadata(retentionDays, currentTime = Date.now()) {
      const cutoff = new Date(currentTime - retentionDays * 86400000).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const usage = db.prepare(`DELETE FROM usage WHERE created_at<? AND (request_id IS NULL OR NOT EXISTS
          (SELECT 1 FROM chat_requests WHERE chat_requests.user_id=usage.user_id
           AND chat_requests.request_id=usage.request_id AND chat_requests.status='running'))`).run(cutoff).changes;
        const requests = db.prepare(`DELETE FROM chat_requests WHERE created_at<? AND status<>'running' AND NOT EXISTS
          (SELECT 1 FROM usage WHERE usage.user_id=chat_requests.user_id AND usage.request_id=chat_requests.request_id)`)
          .run(cutoff).changes;
        const webSessions = db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(currentTime).changes;
        const nativeSessions = db.prepare('DELETE FROM native_sessions WHERE expires_at<=?').run(currentTime).changes;
        db.exec('COMMIT');
        return { usage, requests, webSessions, nativeSessions };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    usage(userId) {
      const sums = db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS inputTokens,
        COALESCE(SUM(output_tokens),0) AS outputTokens,COALESCE(SUM(cache_hit_tokens),0) AS cacheHitTokens,
        COALESCE(SUM(cache_miss_tokens),0) AS cacheMissTokens,
        COALESCE(SUM(CASE WHEN mode='live' THEN 1 ELSE 0 END),0) AS liveRequests,
        COALESCE(SUM(CASE WHEN mode='demo' THEN 1 ELSE 0 END),0) AS demoRequests FROM usage WHERE user_id=?`).get(userId);
      const recent = db.prepare(`SELECT id,request_id AS requestId,conversation_id AS conversationId,message_id AS messageId,mode,status,
        input_tokens AS inputTokens,output_tokens AS outputTokens,cache_hit_tokens AS cacheHitTokens,
        cache_miss_tokens AS cacheMissTokens,source,created_at AS createdAt FROM usage WHERE user_id=?
        ORDER BY created_at DESC LIMIT 50`).all(userId);
      return { totals: sums, recent };
    },
    recoverInterrupted() {
      const interruptedRequests = db.prepare("SELECT * FROM chat_requests WHERE status='running'").all();
      for (const entry of interruptedRequests) {
        const inputTokens = entry.mode === 'demo' ? 0 : Math.ceil(entry.input_characters / 2);
        this.finishChatRequest(entry.user_id, entry.request_id, {
          conversationId: entry.conversation_id, messageId: entry.message_id, mode: entry.mode, status: 'stopped',
          inputTokens, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: inputTokens,
          source: entry.mode === 'demo' ? 'demo' : 'estimate',
        });
      }
      const rows = db.prepare('SELECT * FROM conversations').all();
      for (const row of rows) {
        const conversation = recordToConversation(row);
        let changed = false;
        for (const message of conversation.messages) if (message.status === 'generating') {
          message.status = 'stopped'; changed = true;
        }
        if (changed) this.saveConversation(row.user_id, conversation);
      }
    },
    close() { db.close(); },
  };
  store.recoverInterrupted();
  return store;
}
