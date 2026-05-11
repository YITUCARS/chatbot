// 示例数据填充：仅在首次启动（数据库空）时调用
// 包含租车行业常见话术与知识库条目，以及默认系统设置。

const bcrypt = require('bcrypt')
const dbApi = require('./db')

const SAMPLE_SCRIPTS = [
  { category: '问候',   triggers: ['你好', '您好', 'hi', 'hello'], reply: '您好！欢迎咨询 yitu 租车，我是您的智能助手。请问有什么可以帮您？' },
  { category: '联系方式', triggers: ['电话', '联系方式', '人工'],   reply: '客服电话：400-xxx-xxxx（9:00-21:00）\n微信：yitu-rental' },
  { category: '营业时间', triggers: ['几点', '营业时间', '上班时间', '门店时间'], reply: '门店营业时间：每天 8:00-22:00\n24 小时还车请提前预约' },
  { category: '门店位置', triggers: ['门店', '地址', '在哪', '位置'], reply: '我们在以下城市有门店：上海、杭州、苏州。具体地址可在「联系方式」中咨询客服～' },
  { category: '支付方式', triggers: ['怎么付款', '支付', '付钱', '付款方式'], reply: '支持支付宝、微信、银行卡、现金（押金）。租金可分期。' },
  { category: '发票',    triggers: ['发票', '开票', '报销'], reply: '可开增值税普通发票或专用发票，还车后 3 个工作日内开具。请向门店提供抬头和税号。' },
  { category: '取消订单', triggers: ['取消', '退订', '不租了'], reply: '用车前 24 小时取消免费；24 小时内取消扣 30% 押金；用车当天取消押金不退。' },
  { category: '感谢',    triggers: ['谢谢', '感谢', 'thanks'], reply: '不客气！还有其他问题随时问我哦 😊' },
  { category: '再见',    triggers: ['再见', '拜拜', 'bye'], reply: '感谢咨询 yitu 租车，祝您出行愉快！' },
  { category: '投诉',    triggers: ['投诉', '差评', '不满意'], reply: '非常抱歉给您带来不好的体验。请拨打投诉专线 400-xxx-xxxx 转 9，我们会立即处理。' },
]

const SAMPLE_KNOWLEDGE = [
  {
    category: '押金',
    title: '押金标准与退还流程',
    keywords: ['押金', '押多少', '押金多少', '退押金', '押金退还'],
    content:
`押金标准按车型分级：
• 经济型（轩逸、朗逸等）：¥3,000
• 舒适型（凯美瑞、雅阁等）：¥5,000
• SUV（途观、CR-V 等）：¥6,000
• 豪华型（宝马、奔驰）：¥10,000

支持现金、微信、支付宝、银行卡预授权。
还车验收无违章、无损伤后，3 个工作日内原路退回；如涉及违章查询，待违章处理完毕后退还。`,
  },
  {
    category: '车型价格',
    title: '各车型日租与周租价格',
    keywords: ['多少钱', '价格', '日租', '周租', '报价', '费用'],
    content:
`日租价格（含基础保险）：
• 经济型 ¥150/天起
• 舒适型 ¥280/天起
• SUV ¥350/天起
• 商务车（GL8 等）¥480/天起
• 豪华型 ¥800/天起

租期优惠：
• 3 天以上 9 折
• 7 天以上 8.5 折
• 30 天以上联系客服定制月租价`,
  },
  {
    category: '保险',
    title: '保险方案与理赔范围',
    keywords: ['保险', '理赔', '出险', '撞车', '刮蹭'],
    content:
`我们提供两档保险：

【基础保险】（已含在租金内）
• 第三者责任险 50 万
• 车损险（自付 1500 元起赔）

【全险】（+¥80/天）
• 第三者责任险 100 万
• 车损险全额赔付（自付 0 元）
• 玻璃单独破碎险
• 轮胎损失险

出险流程：第一时间报警 + 联系我们的 24 小时救援电话，保留现场照片。`,
  },
  {
    category: '取还车',
    title: '取车与还车流程',
    keywords: ['取车', '还车', '流程', '怎么取', '怎么还', '门店', '机场'],
    content:
`取车流程：
1. 携带身份证 + 驾照原件到门店
2. 验车（外观、油量、里程数，门店人员陪同）
3. 签合同 + 交押金
4. 提车

还车流程：
1. 提前 1 小时电话预约还车时间
2. 加满油（或按合同约定油量）
3. 门店验车（约 15 分钟）
4. 退押金

机场/高铁站送取车：+¥50/次（部分城市免费，详询客服）`,
  },
  {
    category: '驾照',
    title: '承租人资质要求',
    keywords: ['驾照', '驾龄', '要求', '资质', '谁能租', '年龄'],
    content:
`承租人需满足：
• 年满 22 周岁
• 持有效中国大陆 C1 及以上驾照
• 驾龄满 1 年
• 提供身份证原件（非复印件）

外籍人士需额外提供：护照 + 中国驾照或国际驾照公证件。

70 岁以上需提供近 3 个月内体检报告。`,
  },
  {
    category: '异地用车',
    title: '跨城市/省份用车规定',
    keywords: ['外地', '跨省', '异地', '开出去', '跨城', '长途', '西藏', '新疆'],
    content:
`跨城市/省份用车需满足：
• 提前在合同中报备目的地
• 单程超 500 km 需缴纳长途押金 ¥2,000（还车后退）
• 仅限本公司服务城市还车（上海、杭州、苏州），异地还车需缴异地费 ¥800-1500

禁止行驶区域：西藏、新疆部分地区（详询客服）。`,
  },
  {
    category: '违章',
    title: '违章处理与代办',
    keywords: ['违章', '罚款', '扣分', '超速', '闯红灯'],
    content:
`违章处理规则：
• 还车后我们会在 7 个工作日内查询违章
• 罚款由承租人承担
• 我们提供违章代办服务（¥50/次）
• 扣分需由本人到交管局处理，或委托代办（费用另议）

建议安装「交管 12123」APP 自行处理，省时省钱。`,
  },
  {
    category: '优惠活动',
    title: '会员折扣与节假日活动',
    keywords: ['优惠', '折扣', '活动', '会员', '便宜'],
    content:
`长期优惠：
• 注册会员立减 ¥50
• 老客户推荐返 ¥100/单
• 企业月租 8 折

节假日：
• 春节/国庆等节假日租金有 10%-20% 上浮（按合同约定）
• 提前 30 天预订可锁定平日价

关注我们的微信公众号「yitu 租车」获取最新活动。`,
  },
]

const DEFAULT_SETTINGS = {
  bot_name: 'yitu 租车助手',
  welcome_msg:
    '您好！欢迎咨询 yitu 租车 🚗\n我可以帮您解答：车型价格、押金、保险、取还车、违章等问题。\n请问有什么需要了解的？',
  provider: 'claude',
  claude_model: 'claude-sonnet-4-6',
  openai_model: 'gpt-4o',
  max_tokens: 1000,
  script_first: true,
  log_enabled: true,
  enabled: true,
  system_prompt:
`你是 yitu 租车公司（新西兰）的智能客服助手，主要为自驾游客户提供咨询服务。
- 语气友好、专业、简洁，全程用中文回复。
- 业务相关问题（车型、价格、押金、保险、取还车流程等）：依据系统提供的知识库资料回答，资料里没有的具体数字或政策不要编造，建议用户联系客服确认。
- 通用问题（天气、景点、路况、签证、新西兰旅行常识等）：可以基于你的通用知识热情简洁地回答，让客户感到贴心。
- 涉及具体订单、个人账户、合同细节时，引导用户联系门店或客服核实。`,
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

  if (scriptCount === 0) {
    SAMPLE_SCRIPTS.forEach(s => dbApi.upsertScript(s))
    console.log(`[seed] 已写入 ${SAMPLE_SCRIPTS.length} 条示例话术`)
  }

  if (kbCount === 0) {
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
}

module.exports = { seedIfEmpty }
