// mood-mapper.js — Phase 12-A
// 執行: node midnight-be/functions/mood-mapper.js
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadDotEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(__dirname, '..', '.env'), 'utf-8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
    )
  } catch {
    return {}
  }
}
const env = { ...loadDotEnv(), ...process.env }

const PORT = env.MOOD_MAPPER_PORT || 3001
const DIRECTUS_BASE = env.DIRECTUS_BASE || 'http://localhost:8055'
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY

if (!ANTHROPIC_KEY) {
  console.error('❌ 缺少 ANTHROPIC_API_KEY，請在 midnight-be/.env 新增：ANTHROPIC_API_KEY=你的key')
  process.exit(1)
}

// 備用標籤（Directus 不可用時使用）
const FALLBACK_TAGS = [
  '愛情','浪漫','療癒','溫馨','放鬆','平靜','驚悚','懸疑','燒腦',
  '喜劇','科幻','奇幻','動作','犯罪','文藝','劇情','寂寞','憂鬱',
  '戰爭','末日','社會','政治','紀錄片','冒險','LGBTQ','邪典','諷刺','青春',
]

async function getTags() {
  try {
    const res = await fetch(`${DIRECTUS_BASE}/items/tags?limit=-1&fields=name`, {
      signal: AbortSignal.timeout(3000),
    })
    const { data } = await res.json()
    const names = (data ?? []).map(t => t.name).filter(Boolean)
    return names.length > 0 ? names : FALLBACK_TAGS
  } catch {
    return FALLBACK_TAGS
  }
}

async function callClaude(mood, tagNames) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      system: [
        {
          type: 'text',
          text: `你是一個電影推薦助手。以下是所有可用的電影情緒標籤：\n${tagNames.join('、')}\n\n根據使用者描述的心情，從上方標籤中選出最相關的 3–5 個，按相關度由高到低排序。只回傳 JSON 陣列，不含任何說明。範例：["療癒","愛情","浪漫"]`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: mood }],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message ?? `Claude API ${res.status}`)
  }

  const data = await res.json()
  const text = data.content?.[0]?.text?.trim() ?? '[]'
  const match = text.match(/\[[\s\S]*?\]/)
  if (!match) return []
  const parsed = JSON.parse(match[0])
  return Array.isArray(parsed)
    ? parsed.filter(t => typeof t === 'string' && tagNames.includes(t)).slice(0, 5)
    : []
}

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:5174',
  ...(env.CORS_ORIGIN?.split(',').map(s => s.trim()) ?? []),
])

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin ?? ''
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' })); return
  }

  let body = ''
  try {
    for await (const chunk of req) body += chunk
    const { mood } = JSON.parse(body)

    if (!mood?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '缺少 mood 參數' })); return
    }

    const tagNames = await getTags()
    const tags = await callClaude(mood.trim(), tagNames)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ tags }))
  } catch (err) {
    console.error('[mood-mapper]', err?.message ?? err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '分析失敗，請稍後再試' }))
  }
})

server.listen(PORT, () => {
  console.log(`🎭 Mood Mapper 啟動於 http://localhost:${PORT}`)
  console.log(`   用法: POST http://localhost:${PORT}  { "mood": "最近有點焦慮..." }`)
})
