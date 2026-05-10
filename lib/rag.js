// 知识库检索：纯关键词打分，不引入向量库
//
// 用户问题 → 切分候选词 → 对每条知识库条目算分 → 取 Top 5
// 命中位置加权：title +3 / keywords +2 (每个) / content +1 / category +1

const { listKnowledge } = require('./db')

// 简单分词：把中文按 2-4 字滑窗 + 全句保留 + 拆英文/数字
function tokenize(text) {
  if (!text) return []
  const s = String(text).toLowerCase().trim()
  const tokens = new Set()
  tokens.add(s)

  // 英文/数字直接按空格、标点拆
  s.split(/[\s,，。！？!?\.;:、\/\\()（）"'""'']+/).filter(Boolean).forEach(t => {
    if (t.length >= 2) tokens.add(t)
  })

  // 中文：按 2、3、4 字滑窗
  const han = s.replace(/[^一-龥]/g, '')
  for (const len of [2, 3, 4]) {
    for (let i = 0; i + len <= han.length; i++) {
      tokens.add(han.slice(i, i + len))
    }
  }
  return [...tokens].filter(t => t.length >= 2)
}

function searchKnowledge(query, topK = 5) {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return []
  const tokens = tokenize(query)
  if (!tokens.length) return []

  const all = listKnowledge()
  const scored = all.map(item => {
    let score = 0
    const title = (item.title || '').toLowerCase()
    const content = (item.content || '').toLowerCase()
    const category = (item.category || '').toLowerCase()
    const keywords = (item.keywords || []).map(k => String(k).toLowerCase())

    // 关键词：要求 keyword 整段出现在用户原始 query 里（单向，避免短子串误命中）
    for (const kw of keywords) {
      if (kw && q.includes(kw)) score += 3
    }
    if (category && q.includes(category)) score += 2

    // title / content：用 token 子串检索
    for (const tok of tokens) {
      if (title.includes(tok)) score += 2
      if (content.includes(tok)) score += 1
    }
    return { item, score }
  })

  // 阈值 3：单个 keyword 命中即够，或 title + content 双命中也够
  return scored
    .filter(s => s.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.item)
}

// 话术匹配：按关键词数组匹配，全等或包含都算
function matchScript(query, scripts) {
  if (!query) return null
  const q = query.toLowerCase().trim()
  // 排序：触发词长的优先（避免短词误命中）
  const sorted = [...scripts].sort((a, b) => {
    const maxA = Math.max(0, ...(a.triggers || []).map(t => t.length))
    const maxB = Math.max(0, ...(b.triggers || []).map(t => t.length))
    return maxB - maxA
  })
  for (const s of sorted) {
    for (const t of s.triggers || []) {
      const tl = String(t).toLowerCase().trim()
      if (!tl) continue
      if (q === tl || q.includes(tl)) return s
    }
  }
  return null
}

module.exports = { searchKnowledge, matchScript, tokenize }
