// AI 调用封装：支持 Claude（Anthropic）与 OpenAI 两种 provider
// 关键点：把检索到的知识库内容拼进 system prompt，让模型基于资料回答

function buildSystemPrompt(basePrompt, knowledgeItems) {
  const intro = (basePrompt || '').trim()
  const hasKB = knowledgeItems && knowledgeItems.length > 0

  // 分层策略：
  // - "业务事实"（价格/押金/保险/合同条款/具体车型规格等）严格按知识库，缺资料就请用户联系客服
  // - "通用知识"（天气/景点推荐/路况/旅行常识/新西兰生活信息等）允许基于通用知识直接回答
  // 这样可以避免一个简单的"皇后镇天气怎么样"被拒答
  if (!hasKB) {
    return `${intro}

【本轮回答策略】
- 本次没有从内部知识库中检索到匹配资料。
- 如果用户的问题属于「租车业务事实」（具体价格、押金金额、保险条款、合同政策、库存等只有内部能确认的信息），请说"这部分我需要帮您确认一下，建议直接联系客服"，不要编造数字或条款。
- 如果用户的问题属于「通用知识」（天气、景点推荐、路况、签证、新西兰生活常识、旅行 tips 等），请基于你的通用知识热情、简洁地直接回答，体现专业贴心的服务。
- 全程用中文回复，语气友好专业。`
  }

  const refs = knowledgeItems.map((k, i) =>
`[${i + 1}] 分类：${k.category || '其他'} | 标题：${k.title || ''}
内容：${k.content || ''}`
  ).join('\n\n')

  return `${intro}

【本轮回答策略】
下面是与用户问题相关的内部知识库资料。
- 涉及「业务事实」（价格、押金、保险、政策、合同条款、车型配置等）时，请严格依据下方资料回答，资料没写的不要编造，建议用户联系客服确认。
- 涉及「通用知识」（天气、景点、路况、签证、旅行 tips 等）资料未覆盖的部分，可基于通用常识热情友好地补充回答。
- 全程用中文，语气友好、专业、简洁。

=== 知识库资料 ===
${refs}
=== 资料结束 ===`
}

// data URL → { media_type, data } 用于 Claude；OpenAI 直接吃 dataUrl
function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl || '')
  if (!m) throw new Error('图片数据格式不合法')
  return { media_type: m[1], data: m[2] }
}

function buildClaudeUserContent(text, images) {
  if (!images || images.length === 0) return text
  const blocks = images.map(url => {
    const { media_type, data } = parseDataUrl(url)
    return { type: 'image', source: { type: 'base64', media_type, data } }
  })
  if (text) blocks.push({ type: 'text', text })
  return blocks
}

function buildOpenAIUserContent(text, images) {
  if (!images || images.length === 0) return text
  const parts = []
  if (text) parts.push({ type: 'text', text })
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } })
  return parts
}

// ── Claude (Anthropic Messages API) ──────────────────────────
async function callClaude({ apiKey, model, systemPrompt, history, userMessage, maxTokens, images }) {
  const messages = []
  for (const h of history || []) {
    if (!h?.role || !h?.content) continue
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: String(h.content) })
    }
  }
  messages.push({ role: 'user', content: buildClaudeUserContent(userMessage, images) })

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      max_tokens: maxTokens || 1000,
      system: systemPrompt,
      messages,
    }),
  })

  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const msg = data?.error?.message || resp.statusText || 'Claude API error'
    throw new Error(`Claude API ${resp.status}: ${msg}`)
  }
  const text = (data?.content || []).map(c => c.text || '').join('').trim()
  return text || '（AI 暂时无法生成回复，请稍后再试）'
}

// ── OpenAI Chat Completions ──────────────────────────────────
async function callOpenAI({ apiKey, model, systemPrompt, history, userMessage, maxTokens, images }) {
  const messages = [{ role: 'system', content: systemPrompt }]
  for (const h of history || []) {
    if (h?.role === 'user' || h?.role === 'assistant') {
      messages.push({ role: h.role, content: String(h.content) })
    }
  }
  messages.push({ role: 'user', content: buildOpenAIUserContent(userMessage, images) })

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      max_tokens: maxTokens || 1000,
      messages,
    }),
  })

  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const msg = data?.error?.message || resp.statusText || 'OpenAI API error'
    throw new Error(`OpenAI API ${resp.status}: ${msg}`)
  }
  const text = (data?.choices?.[0]?.message?.content || '').trim()
  return text || '（AI 暂时无法生成回复，请稍后再试）'
}

async function generateReply({ provider, settings, knowledgeItems, history, userMessage, images }) {
  const systemPrompt = buildSystemPrompt(settings.system_prompt, knowledgeItems)
  const maxTokens = Number(settings.max_tokens) || 1000

  if (provider === 'openai') {
    if (!settings.openai_api_key) throw new Error('未配置 OpenAI API Key')
    return callOpenAI({
      apiKey: settings.openai_api_key,
      model: settings.openai_model,
      systemPrompt, history, userMessage, maxTokens, images,
    })
  }

  // 默认 Claude
  if (!settings.claude_api_key) throw new Error('未配置 Claude API Key')
  return callClaude({
    apiKey: settings.claude_api_key,
    model: settings.claude_model,
    systemPrompt, history, userMessage, maxTokens, images,
  })
}

// 测试连接：发一条最小请求确认 Key 可用
async function testConnection({ provider, settings }) {
  const probe = {
    history: [],
    userMessage: 'ping',
    knowledgeItems: [],
    settings: { ...settings, system_prompt: '只回复一个字: ok', max_tokens: 16 },
    provider,
  }
  const reply = await generateReply(probe)
  return { ok: true, sample: reply }
}

module.exports = { generateReply, testConnection, buildSystemPrompt }
