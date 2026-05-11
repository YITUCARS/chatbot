// AI 调用封装：支持 Claude（Anthropic）与 OpenAI 两种 provider
// 关键点：把检索到的知识库内容拼进 system prompt，让模型基于资料回答

function buildSystemPrompt(basePrompt, knowledgeItems) {
  const intro = (basePrompt || '').trim()
  if (!knowledgeItems || knowledgeItems.length === 0) {
    return `${intro}

（本次没有匹配到知识库资料，请基于通用常识简洁回答，或建议用户留下联系方式由人工跟进）`
  }

  const refs = knowledgeItems.map((k, i) =>
`[${i + 1}] 分类：${k.category || '其他'} | 标题：${k.title || ''}
内容：${k.content || ''}`
  ).join('\n\n')

  return `${intro}

你可以参考以下来自我们公司知识库的资料回答用户问题。
**严格要求：只能基于以下资料回答，资料中没有的内容不要编造。
如果资料不足以回答，请说"这个问题我需要确认一下，您可以留下电话由人工客服联系您"。**

=== 知识库资料 ===
${refs}
=== 资料结束 ===

请用友好、专业、简洁的中文回答用户问题。`
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
