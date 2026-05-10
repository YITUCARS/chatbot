// 数据库层：初始化 SQLite 表结构，封装常用 CRUD
// 路由层不直接写 SQL，统一调本文件导出的函数。

const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

const DB_DIR = path.join(__dirname, '..', 'data')
const DB_PATH = path.join(DB_DIR, 'yitu.db')

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ── 建表 ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    triggers TEXT,
    reply TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    title TEXT,
    content TEXT,
    keywords TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_msg TEXT,
    bot_reply TEXT,
    source TEXT,
    matched_kb_ids TEXT,
    provider TEXT,
    session_id TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS unanswered (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT,
    count INTEGER DEFAULT 1,
    last_at INTEGER,
    resolved INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_unanswered_resolved ON unanswered(resolved, count DESC);
`)

// ── 通用工具 ──────────────────────────────────────────────────
const now = () => Date.now()
const toJSON = v => (v == null ? '[]' : JSON.stringify(v))
const fromJSON = s => { try { return JSON.parse(s || '[]') } catch { return [] } }

// ── settings ─────────────────────────────────────────────────
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return fallback
  // 数字、布尔自动转换
  const v = row.value
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  return v
}

function setSetting(key, value) {
  const v = typeof value === 'string' ? value : String(value)
  db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, v)
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const out = {}
  rows.forEach(r => { out[r.key] = getSetting(r.key) })
  return out
}

// ── scripts ──────────────────────────────────────────────────
function listScripts() {
  return db.prepare('SELECT * FROM scripts ORDER BY id DESC').all().map(r => ({
    ...r, triggers: fromJSON(r.triggers),
  }))
}

function upsertScript({ id, category, triggers, reply }) {
  if (id) {
    db.prepare(`UPDATE scripts SET category=?, triggers=?, reply=? WHERE id=?`)
      .run(category || '', toJSON(triggers), reply || '', id)
    return id
  }
  const info = db.prepare(`INSERT INTO scripts(category, triggers, reply, created_at)
                           VALUES(?, ?, ?, ?)`)
    .run(category || '', toJSON(triggers), reply || '', now())
  return info.lastInsertRowid
}

function deleteScript(id) {
  db.prepare('DELETE FROM scripts WHERE id = ?').run(id)
}

// ── knowledge ────────────────────────────────────────────────
function listKnowledge(category) {
  const sql = category
    ? 'SELECT * FROM knowledge WHERE category = ? ORDER BY id DESC'
    : 'SELECT * FROM knowledge ORDER BY id DESC'
  const rows = category ? db.prepare(sql).all(category) : db.prepare(sql).all()
  return rows.map(r => ({ ...r, keywords: fromJSON(r.keywords) }))
}

function getKnowledgeByIds(ids) {
  if (!ids?.length) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM knowledge WHERE id IN (${placeholders})`).all(...ids)
  return rows.map(r => ({ ...r, keywords: fromJSON(r.keywords) }))
}

function upsertKnowledge({ id, category, title, content, keywords }) {
  const t = now()
  if (id) {
    db.prepare(`UPDATE knowledge SET category=?, title=?, content=?, keywords=?, updated_at=?
                WHERE id=?`)
      .run(category || '', title || '', content || '', toJSON(keywords), t, id)
    return id
  }
  const info = db.prepare(`INSERT INTO knowledge(category, title, content, keywords, created_at, updated_at)
                           VALUES(?, ?, ?, ?, ?, ?)`)
    .run(category || '', title || '', content || '', toJSON(keywords), t, t)
  return info.lastInsertRowid
}

function deleteKnowledge(id) {
  db.prepare('DELETE FROM knowledge WHERE id = ?').run(id)
}

// ── logs ─────────────────────────────────────────────────────
function addLog({ user_msg, bot_reply, source, matched_kb_ids, provider, session_id }) {
  db.prepare(`INSERT INTO logs(user_msg, bot_reply, source, matched_kb_ids, provider, session_id, created_at)
              VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(user_msg, bot_reply, source, toJSON(matched_kb_ids || []), provider || '', session_id || '', now())
}

function listLogs(limit = 100) {
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit)
    .map(r => ({ ...r, matched_kb_ids: fromJSON(r.matched_kb_ids) }))
}

// ── unanswered ───────────────────────────────────────────────
function recordUnanswered(question) {
  const trimmed = (question || '').trim().slice(0, 500)
  if (!trimmed) return
  const row = db.prepare('SELECT id, count FROM unanswered WHERE question = ?').get(trimmed)
  if (row) {
    db.prepare('UPDATE unanswered SET count = count + 1, last_at = ? WHERE id = ?')
      .run(now(), row.id)
  } else {
    db.prepare('INSERT INTO unanswered(question, count, last_at, resolved) VALUES(?, 1, ?, 0)')
      .run(trimmed, now())
  }
}

function listUnanswered() {
  return db.prepare('SELECT * FROM unanswered WHERE resolved = 0 ORDER BY count DESC, last_at DESC').all()
}

function resolveUnanswered(id) {
  db.prepare('UPDATE unanswered SET resolved = 1 WHERE id = ?').run(id)
}

// ── 统计 ─────────────────────────────────────────────────────
function getStats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM logs').get().n
  const byScript = db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE source = 'script'`).get().n
  const byRag = db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE source = 'rag'`).get().n
  const byAi = db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE source = 'ai_only'`).get().n
  const unansweredOpen = db.prepare(`SELECT COUNT(*) AS n FROM unanswered WHERE resolved = 0`).get().n
  const scriptCount = db.prepare('SELECT COUNT(*) AS n FROM scripts').get().n
  const kbCount = db.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n
  return { total, byScript, byRag, byAi, unansweredOpen, scriptCount, kbCount }
}

module.exports = {
  db,
  getSetting, setSetting, getAllSettings,
  listScripts, upsertScript, deleteScript,
  listKnowledge, getKnowledgeByIds, upsertKnowledge, deleteKnowledge,
  addLog, listLogs,
  recordUnanswered, listUnanswered, resolveUnanswered,
  getStats,
}
