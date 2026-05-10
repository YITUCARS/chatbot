// yitu 租车智能客服 —— Express 入口
// 路由分两块：/api/admin/* 需登录；/api/chat/* 公开（H5 调用）

require('dotenv').config()
const path = require('path')
const express = require('express')
const session = require('express-session')
const cors = require('cors')
const bcrypt = require('bcrypt')

const db = require('./lib/db')
const { seedIfEmpty } = require('./lib/seed')
const { searchKnowledge, matchScript } = require('./lib/rag')
const { generateReply, testConnection } = require('./lib/ai')

const PORT = Number(process.env.PORT) || 3000
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-env'
const IS_PROD = process.env.NODE_ENV === 'production'

const app = express()
app.set('trust proxy', 1)

// ── CORS：允许 .env 中配置的域名，开发模式放行 localhost ────
const envOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true) // 同源或非浏览器
    if (!IS_PROD && /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(origin)) return cb(null, true)
    if (envOrigins.length === 0) return cb(null, true)
    if (envOrigins.includes(origin)) return cb(null, true)
    return cb(new Error('CORS not allowed: ' + origin))
  },
  credentials: true,
}))

app.use(express.json({ limit: '256kb' }))
app.use(session({
  name: 'yitu.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 3600 * 1000,
  },
}))

// 首次启动：初始化数据
seedIfEmpty()

// ── 工具：登录守卫 ──────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next()
  return res.status(401).json({ error: 'unauthorized' })
}

// ── 工具：API Key 掩码 ────────────────────────────────────────
function maskKey(k) {
  if (!k) return ''
  if (k.length <= 10) return '****'
  return k.slice(0, 4) + '***' + k.slice(-4)
}

// ── 速率限制（极简版）：/api/chat/send 每 IP 每分钟 20 次 ──
const chatRateBucket = new Map() // ip -> { count, resetAt }
function chatRateLimiter(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'unknown'
  const now = Date.now()
  let b = chatRateBucket.get(ip)
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 60_000 }
    chatRateBucket.set(ip, b)
  }
  b.count++
  if (b.count > 20) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
  }
  next()
}

// ───────────────────────────────────────────────────────────
//   Admin API
// ───────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {}
  const hash = db.getSetting('admin_password_hash')
  if (!hash || !password) return res.status(400).json({ error: 'invalid input' })
  const ok = bcrypt.compareSync(String(password), String(hash))
  if (!ok) return res.status(401).json({ error: '密码错误' })
  req.session.isAdmin = true
  res.json({ ok: true })
})

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: !!req.session?.isAdmin })
})

app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }
  const hash = db.getSetting('admin_password_hash')
  if (!bcrypt.compareSync(String(oldPassword || ''), String(hash))) {
    return res.status(401).json({ error: '原密码错误' })
  }
  db.setSetting('admin_password_hash', bcrypt.hashSync(String(newPassword), 10))
  res.json({ ok: true })
})

// scripts
app.get('/api/admin/scripts', requireAdmin, (_req, res) => {
  res.json({ items: db.listScripts() })
})
app.post('/api/admin/scripts', requireAdmin, (req, res) => {
  const { id, category, triggers, reply } = req.body || {}
  if (!reply) return res.status(400).json({ error: '回复内容不能为空' })
  const trigArr = Array.isArray(triggers) ? triggers.map(t => String(t).trim()).filter(Boolean) : []
  const newId = db.upsertScript({ id, category, triggers: trigArr, reply: String(reply).slice(0, 5000) })
  res.json({ ok: true, id: newId })
})
app.delete('/api/admin/scripts/:id', requireAdmin, (req, res) => {
  db.deleteScript(Number(req.params.id))
  res.json({ ok: true })
})

// knowledge
app.get('/api/admin/knowledge', requireAdmin, (req, res) => {
  res.json({ items: db.listKnowledge(req.query.category || '') })
})
app.post('/api/admin/knowledge', requireAdmin, (req, res) => {
  const { id, category, title, content, keywords } = req.body || {}
  if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' })
  if (String(content).length > 10000) return res.status(400).json({ error: '内容超过 10000 字' })
  const kwArr = Array.isArray(keywords) ? keywords.map(k => String(k).trim()).filter(Boolean) : []
  const newId = db.upsertKnowledge({
    id,
    category: String(category || '').slice(0, 100),
    title: String(title).slice(0, 200),
    content: String(content),
    keywords: kwArr,
  })
  res.json({ ok: true, id: newId })
})
app.delete('/api/admin/knowledge/:id', requireAdmin, (req, res) => {
  db.deleteKnowledge(Number(req.params.id))
  res.json({ ok: true })
})

// settings
const PUBLIC_SETTING_KEYS = [
  'bot_name', 'welcome_msg', 'provider', 'claude_model', 'openai_model',
  'max_tokens', 'script_first', 'log_enabled', 'enabled', 'system_prompt',
]
const KEY_SETTING_FIELDS = ['claude_api_key', 'openai_api_key']

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  const all = db.getAllSettings()
  // 屏蔽密码哈希，掩码 API Key
  delete all.admin_password_hash
  KEY_SETTING_FIELDS.forEach(k => { all[k] = maskKey(all[k]) })
  res.json(all)
})

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {}
  for (const k of PUBLIC_SETTING_KEYS) {
    if (k in body) db.setSetting(k, body[k])
  }
  // API Key：只有传入新值且不是掩码时才更新
  for (const k of KEY_SETTING_FIELDS) {
    if (k in body) {
      const v = String(body[k] || '')
      if (v && !v.includes('***')) db.setSetting(k, v)
    }
  }
  res.json({ ok: true })
})

// 测试 API 连接
app.post('/api/admin/test-api', requireAdmin, async (req, res) => {
  try {
    const all = db.getAllSettings()
    const provider = (req.body?.provider) || all.provider || 'claude'
    const result = await testConnection({ provider, settings: all })
    res.json(result)
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

// 统计 + 日志 + 未回答
app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  res.json(db.getStats())
})
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
  res.json({ items: db.listLogs(limit) })
})
app.get('/api/admin/unanswered', requireAdmin, (_req, res) => {
  res.json({ items: db.listUnanswered() })
})
app.post('/api/admin/unanswered/:id/resolve', requireAdmin, (req, res) => {
  db.resolveUnanswered(Number(req.params.id))
  res.json({ ok: true })
})

// ───────────────────────────────────────────────────────────
//   Chat API（公开，H5 调用）
// ───────────────────────────────────────────────────────────

app.get('/api/chat/config', (_req, res) => {
  const s = db.getAllSettings()
  // 从话术里抽 4 个常见类目的代表词作为「快捷问题」按钮
  const scripts = db.listScripts()
  const wanted = ['车型价格', '押金', '保险', '取还车', '联系方式']
  const suggestions = []
  for (const cat of wanted) {
    const hit = scripts.find(x => (x.category || '').includes(cat))
                || db.listKnowledge().find(x => (x.category || '').includes(cat))
    if (hit) suggestions.push(cat)
    if (suggestions.length >= 4) break
  }
  res.json({
    bot_name: s.bot_name || 'yitu 助手',
    welcome_msg: s.welcome_msg || '您好，有什么可以帮您？',
    suggestions: suggestions.length ? suggestions : ['车型价格', '押金', '保险', '取还车'],
    enabled: s.enabled !== false,
  })
})

app.post('/api/chat/send', chatRateLimiter, async (req, res) => {
  try {
    const { message, session_id, history } = req.body || {}
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: '消息不能为空' })
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: '消息过长（最多 1000 字）' })
    }

    const settings = db.getAllSettings()
    if (settings.enabled === false) {
      return res.json({ reply: '客服系统暂时关闭，请稍后再试或联系电话客服。', source: 'system' })
    }

    // 1. 话术匹配
    if (settings.script_first !== false) {
      const script = matchScript(message, db.listScripts())
      if (script) {
        const reply = script.reply
        if (settings.log_enabled !== false) {
          db.addLog({
            user_msg: message, bot_reply: reply, source: 'script',
            matched_kb_ids: [], provider: '', session_id,
          })
        }
        return res.json({ reply, source: 'script' })
      }
    }

    // 2. 知识库检索
    const kbItems = searchKnowledge(message, 5)

    // 3. AI 生成
    const provider = settings.provider || 'claude'
    let reply
    try {
      reply = await generateReply({
        provider,
        settings,
        knowledgeItems: kbItems,
        history: Array.isArray(history) ? history.slice(-10) : [],
        userMessage: message,
      })
    } catch (e) {
      console.error('[AI error]', e.message)
      // 兜底
      if (kbItems.length > 0) {
        // 至少能给一段知识库摘要
        reply = `关于您的问题，请参考以下信息：\n\n${kbItems[0].content}\n\n如需进一步咨询，请联系人工客服。`
      } else {
        reply = '抱歉，我暂时无法回答这个问题。您可以留下电话，由人工客服联系您～'
        db.recordUnanswered(message)
      }
      if (settings.log_enabled !== false) {
        db.addLog({
          user_msg: message, bot_reply: reply, source: 'fallback',
          matched_kb_ids: kbItems.map(k => k.id), provider, session_id,
        })
      }
      return res.json({ reply, source: 'fallback', error: e.message })
    }

    const source = kbItems.length > 0 ? 'rag' : 'ai_only'
    if (kbItems.length === 0) db.recordUnanswered(message)

    if (settings.log_enabled !== false) {
      db.addLog({
        user_msg: message, bot_reply: reply, source,
        matched_kb_ids: kbItems.map(k => k.id), provider, session_id,
      })
    }

    res.json({ reply, source, matched: kbItems.map(k => ({ id: k.id, title: k.title })) })
  } catch (e) {
    console.error('[chat/send] error:', e)
    res.status(500).json({ error: '服务器开了个小差，请稍后再试' })
  }
})

// 用户反馈（可选）
app.post('/api/chat/feedback', (req, res) => {
  const { question } = req.body || {}
  if (question) db.recordUnanswered(String(question).slice(0, 500))
  res.json({ ok: true })
})

// ── 静态资源 ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')))
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'yitu-admin.html')))
app.get('/chat', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'yitu-chat.html')))
app.get('/', (_req, res) => res.redirect('/admin'))

// ── 错误兜底 ────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[uncaught]', err)
  res.status(500).json({ error: '服务器错误' })
})

app.listen(PORT, () => {
  console.log(`\n  yitu 智能客服服务已启动`)
  console.log(`  ▸ 后台管理:  http://localhost:${PORT}/admin   (默认密码 admin123)`)
  console.log(`  ▸ H5 客服:   http://localhost:${PORT}/chat`)
  console.log(`  ▸ 端口:      ${PORT}    环境: ${IS_PROD ? 'production' : 'development'}\n`)
})
