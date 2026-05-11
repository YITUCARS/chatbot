// 示例数据填充：仅在首次启动（数据库空）时调用
// 包含租车行业常见话术与知识库条目，以及默认系统设置。

const bcrypt = require('bcrypt')
const dbApi = require('./db')

// 不再预置示例话术——所有话术由管理员在后台添加
const SAMPLE_SCRIPTS = []

// 不再预置示例知识——所有知识库条目由管理员在后台添加
const SAMPLE_KNOWLEDGE = []

const DEFAULT_SETTINGS = {
  bot_name: 'YITU旅行助手',
  welcome_msg:
`YITU旅行助手 · 在线智能客服
7×24 小时在线问答：行程规划、美食推荐、路标/标识解释、旅行攻略、当地建议、日常问题等，一问即答。`,
  provider: 'claude',
  claude_model: 'claude-sonnet-4-6',
  openai_model: 'gpt-5',
  max_tokens: 1000,
  script_first: true,
  log_enabled: true,
  enabled: true,
  system_prompt:
`你是 YITU 旅行助手（新西兰），一个面向自由行旅客的智能客服助手。
- 语气友好、专业、热心，全程用中文回复。
- 擅长解答：行程规划、景点推荐、美食推荐、路标/标识解释、旅行攻略、当地交通/治安/天气常识、签证常识、日常旅行问题等。
- 用户可以上传图片（路标、菜单、票据、地标等），请认真识别图片内容后再作答。
- 涉及具体订单、个人账户、合同细节时，引导用户联系门店或客服核实。
- 遇到需要实时信息（汇率、航班时刻、精确天气预报等）的问题，请给出常识性参考，并建议用户查询权威渠道。`,
  claude_api_key: '',
  openai_api_key: '',
}

// 旧版严格 prompt — 用于一次性自动迁移：如果 DB 里仍是这个字符串，说明用户没编辑过，安全升级
const OLD_STRICT_PROMPT =
`你是 yitu 租车公司的专业客服助手。
请遵守以下规则：
1. 只回答与租车业务相关的问题
2. 严格基于提供的知识库资料回答，不要编造价格、政策等具体信息
3. 语气友好、专业、简洁，用中文回复
4. 如果知识库没有相关信息，建议用户留下联系方式由人工客服跟进
5. 涉及具体订单、个人信息时，引导用户联系门店`

function seedIfEmpty() {
  const scriptCount = dbApi.db.prepare('SELECT COUNT(*) AS n FROM scripts').get().n
  const kbCount = dbApi.db.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n
  const settingsCount = dbApi.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n

  if (scriptCount === 0 && SAMPLE_SCRIPTS.length > 0) {
    SAMPLE_SCRIPTS.forEach(s => dbApi.upsertScript(s))
    console.log(`[seed] 已写入 ${SAMPLE_SCRIPTS.length} 条示例话术`)
  }

  if (kbCount === 0 && SAMPLE_KNOWLEDGE.length > 0) {
    SAMPLE_KNOWLEDGE.forEach(k => dbApi.upsertKnowledge(k))
    console.log(`[seed] 已写入 ${SAMPLE_KNOWLEDGE.length} 条示例知识`)
  }

  if (settingsCount === 0) {
    Object.entries(DEFAULT_SETTINGS).forEach(([k, v]) => dbApi.setSetting(k, v))
    const hash = bcrypt.hashSync('admin123', 10)
    dbApi.setSetting('admin_password_hash', hash)
    console.log('[seed] 已写入默认设置；后台默认密码: admin123（请首次登录后立即修改）')
  }

  // 一次性迁移：旧版"严格 KB"prompt 会让 AI 拒答天气/景点等通用问题。
  // 如果当前 DB 里的 system_prompt 仍然与旧版逐字一致，说明用户没改过，安全升级到新版。
  const currentPrompt = dbApi.getSetting('system_prompt')
  if (currentPrompt && currentPrompt.trim() === OLD_STRICT_PROMPT.trim()) {
    dbApi.setSetting('system_prompt', DEFAULT_SETTINGS.system_prompt)
    console.log('[seed] 检测到旧版严格 system_prompt，已自动升级为分层策略版本（允许 AI 回答通用问题）')
  }

  // 一次性迁移：把仍停留在 gpt-4o（2024 年 5 月旧默认）的用户升到 gpt-5。
  // 只在「与旧默认完全一致」时才动，保留用户的手动选择。
  const currentOpenAIModel = dbApi.getSetting('openai_model')
  if (currentOpenAIModel === 'gpt-4o') {
    dbApi.setSetting('openai_model', DEFAULT_SETTINGS.openai_model)
    console.log(`[seed] OpenAI 默认模型升级：gpt-4o → ${DEFAULT_SETTINGS.openai_model}`)
  }
}

module.exports = { seedIfEmpty }
