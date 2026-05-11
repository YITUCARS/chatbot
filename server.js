// yitu 租车智能客服 —— Express 入口
// 路由分两块：/api/admin/* 需登录；/api/chat/* 公开（H5 调用）

require('dotenv').config()
const fs = require('fs')
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
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '')

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

// 8mb：支持最多 4 张图片（前端已压缩至长边 ≤1568px JPEG）+ 文本/历史
app.use(express.json({ limit: '8mb' }))
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

// 拉取 provider 可用模型列表（直接调官方 /v1/models 接口）
// 1 分钟内存缓存，避免后台多次切换/刷新时反复 hit
const modelsCache = new Map()  // key: provider:apiKeyHash → { at, list }
const MODELS_TTL_MS = 60_000

// 简单哈希，避免 key 进缓存键
function hashKey(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return String(h)
}

// 过滤出聊天/视觉类模型，剔除 embeddings / tts / whisper / dall-e / moderation 等
function isOpenAIChatModel(id) {
  if (!/^(gpt-|chatgpt-|o\d)/i.test(id)) return false
  if (/embedding|whisper|tts|dall-e|moderation|search|realtime|transcribe/i.test(id)) return false
  return true
}

async function fetchOpenAIModels(apiKey) {
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data?.error?.message || `OpenAI ${resp.status}`)
  const list = (data.data || [])
    .filter(m => isOpenAIChatModel(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(m => ({ id: m.id, created: m.created, owned_by: m.owned_by }))
  return list
}

async function fetchClaudeModels(apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(data?.error?.message || `Claude ${resp.status}`)
  const list = (data.data || [])
    .map(m => ({ id: m.id, display_name: m.display_name, created: Date.parse(m.created_at || '') / 1000 || 0 }))
    .sort((a, b) => b.created - a.created)
  return list
}

app.post('/api/admin/models', requireAdmin, async (req, res) => {
  try {
    const all = db.getAllSettings()
    const body = req.body || {}
    const provider = body.provider || all.provider || 'claude'

    // 优先使用前端传入的未保存 key（首次配置场景），否则用 DB 里已保存的
    const keyField = provider === 'openai' ? 'openai_api_key' : 'claude_api_key'
    const rawOverride = body[keyField]
    const overrideValid = typeof rawOverride === 'string' && rawOverride && !rawOverride.includes('***')
    const apiKey = overrideValid ? rawOverride : all[keyField]
    if (!apiKey) {
      return res.status(400).json({ error: `请先填写 ${provider === 'openai' ? 'OpenAI' : 'Claude'} API Key` })
    }

    const cacheKey = `${provider}:${hashKey(apiKey)}`
    const cached = modelsCache.get(cacheKey)
    if (cached && Date.now() - cached.at < MODELS_TTL_MS && !body.force) {
      return res.json({ models: cached.list, cached: true })
    }

    const list = provider === 'openai' ? await fetchOpenAIModels(apiKey) : await fetchClaudeModels(apiKey)
    modelsCache.set(cacheKey, { at: Date.now(), list })
    res.json({ models: list, cached: false })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// 测试 API 连接
// 允许前端临时传入未保存的 key / model 做合并测试，支持「先测试再保存」流程
app.post('/api/admin/test-api', requireAdmin, async (req, res) => {
  try {
    const all = db.getAllSettings()
    const body = req.body || {}
    const provider = body.provider || all.provider || 'claude'
    const merged = { ...all }
    const override = (k) => {
      if (k in body) {
        const v = String(body[k] || '')
        if (v && !v.includes('***')) merged[k] = v
      }
    }
    override('claude_api_key')
    override('openai_api_key')
    if (body.claude_model) merged.claude_model = body.claude_model
    if (body.openai_model) merged.openai_model = body.openai_model
    const result = await testConnection({ provider, settings: merged })
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

// 校验前端传来的 base64 data URL：必须是 image/* 且大小可控
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/
const MAX_IMAGES_PER_MSG = 4
const MAX_IMAGE_BASE64_LEN = 6 * 1024 * 1024  // 单张图 base64 字符串上限 ~6MB（解码后 ~4.5MB）

function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0) return []
  if (images.length > MAX_IMAGES_PER_MSG) {
    throw new Error(`最多附带 ${MAX_IMAGES_PER_MSG} 张图片`)
  }
  for (const url of images) {
    if (typeof url !== 'string' || !DATA_URL_RE.test(url)) {
      throw new Error('图片格式不合法')
    }
    if (url.length > MAX_IMAGE_BASE64_LEN) {
      throw new Error('单张图片过大，请重试')
    }
  }
  return images
}

app.post('/api/chat/send', chatRateLimiter, async (req, res) => {
  try {
    const { message, session_id, history } = req.body || {}
    let images = []
    try { images = validateImages(req.body?.images) } catch (e) { return res.status(400).json({ error: e.message }) }

    const hasText = typeof message === 'string' && message.trim().length > 0
    const hasImages = images.length > 0
    if (!hasText && !hasImages) {
      return res.status(400).json({ error: '消息不能为空' })
    }
    if (hasText && message.length > 1000) {
      return res.status(400).json({ error: '消息过长（最多 1000 字）' })
    }
    const userMessage = hasText ? message : '（用户上传了图片，请基于图片内容回答）'

    const settings = db.getAllSettings()
    if (settings.enabled === false) {
      return res.json({ reply: '客服系统暂时关闭，请稍后再试或联系电话客服。', source: 'system' })
    }

    // 1. 话术匹配（仅纯文本时尝试，图片消息直接走 AI）
    if (!hasImages && settings.script_first !== false) {
      const script = matchScript(userMessage, db.listScripts())
      if (script) {
        const reply = script.reply
        if (settings.log_enabled !== false) {
          db.addLog({
            user_msg: userMessage, bot_reply: reply, source: 'script',
            matched_kb_ids: [], provider: '', session_id,
          })
        }
        return res.json({ reply, source: 'script' })
      }
    }

    // 2. 知识库检索（基于文本；纯图片消息会得到空数组）
    const kbItems = hasText ? searchKnowledge(userMessage, 5) : []

    // 日志里只标记图片数量，不存 base64（会撑爆 DB）
    const logUserMsg = hasImages ? `[图片 ${images.length} 张] ${hasText ? userMessage : ''}`.trim() : userMessage

    // 3. AI 生成
    const provider = settings.provider || 'claude'
    let reply
    try {
      reply = await generateReply({
        provider,
        settings,
        knowledgeItems: kbItems,
        history: Array.isArray(history) ? history.slice(-10) : [],
        userMessage,
        images,
      })
    } catch (e) {
      console.error('[AI error]', e.message)
      // 兜底
      if (hasImages) {
        reply = `抱歉，识别图片时出错了：${e.message}。请稍后再试，或用文字描述您的问题。`
      } else if (kbItems.length > 0) {
        reply = `关于您的问题，请参考以下信息：\n\n${kbItems[0].content}\n\n如需进一步咨询，请联系人工客服。`
      } else {
        reply = '抱歉，我暂时无法回答这个问题。您可以留下电话，由人工客服联系您～'
        db.recordUnanswered(userMessage)
      }
      if (settings.log_enabled !== false) {
        db.addLog({
          user_msg: logUserMsg, bot_reply: reply, source: 'fallback',
          matched_kb_ids: kbItems.map(k => k.id), provider, session_id,
        })
      }
      return res.json({ reply, source: 'fallback', error: e.message })
    }

    const source = hasImages ? 'ai_vision' : (kbItems.length > 0 ? 'rag' : 'ai_only')
    if (!hasImages && kbItems.length === 0) db.recordUnanswered(userMessage)

    if (settings.log_enabled !== false) {
      db.addLog({
        user_msg: logUserMsg, bot_reply: reply, source,
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

// /chat：注入 PUBLIC_BASE_URL 用于 Open Graph / 微信卡片 meta 的绝对地址
const chatHtmlRaw = fs.readFileSync(path.join(__dirname, 'public', 'yitu-chat.html'), 'utf8')
const chatHtml = chatHtmlRaw.replace(/__PUBLIC_BASE_URL__/g, PUBLIC_BASE_URL)
app.get('/chat', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(chatHtml)
})

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
