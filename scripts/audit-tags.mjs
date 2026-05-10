// audit-tags.mjs — Phase 3 跑完後驗收
//
// 執行：node midnight-be/scripts/audit-tags.mjs
//
// 報告：
//   1. 每個 tag 的電影數（依 category 分組、weight 分布）
//   2. 空 tag 列表
//   3. 沒有 mood/style tag 的電影（純類型片，可能合理）
//   4. 各 mood/style tag 抽樣 3 部片名（人工 spot check）
//   5. 過度標的電影（mood+style 超過 5 個）
//   6. 整體統計

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf-8')
    .split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const BASE = 'http://localhost:8055'
const SAMPLE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] ?? '3')

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD}),
  }).then(r => r.json())
  if (!r.data?.access_token) { console.error('登入失敗'); process.exit(1) }
  return r.data.access_token
}

async function main() {
  const token = await login()

  // Fetch all tags
  const tagsRes = await fetch(`${BASE}/items/tags?limit=-1&fields=id,name,category`,
    {headers:{Authorization:`Bearer ${token}`}}).then(r => r.json())
  const allTags = tagsRes.data
  const tagById = Object.fromEntries(allTags.map(t => [t.id, t]))

  // Fetch all movies with tags
  const moviesRes = await fetch(`${BASE}/items/movies?limit=-1&fields=id,title,year,tags.weight,tags.tags_id.id,tags.tags_id.name,tags.tags_id.category`,
    {headers:{Authorization:`Bearer ${token}`}}).then(r => r.json())
  const movies = moviesRes.data
  console.log(`📊 樣本：${movies.length} 部電影、${allTags.length} 個 tag\n`)

  // ── 1. 每個 tag 的分布 ─────────────────────────────────
  const tagStats = {}  // {tag_name: {category, count, w1: n, w2: n, samples: []}}
  for (const t of allTags) {
    tagStats[t.name] = {category: t.category, count: 0, w1: 0, w2: 0, samples: []}
  }
  for (const m of movies) {
    for (const tj of m.tags ?? []) {
      const tname = tj.tags_id?.name
      if (!tname) continue
      const s = tagStats[tname]
      if (!s) continue
      s.count++
      if (tj.weight === 2) s.w2++
      else s.w1++
      if (s.samples.length < 30) s.samples.push(`《${m.title}》(${m.year})`)
    }
  }

  console.log('═══ 1. Tag 分布 ═══\n')
  for (const cat of ['情緒', '類型', '風格']) {
    console.log(`▼ ${cat}`)
    const rows = Object.entries(tagStats).filter(([_, s]) => s.category === cat)
      .sort((a, b) => b[1].count - a[1].count)
    for (const [name, s] of rows) {
      const flag = s.count === 0 ? '✗' : s.count < 5 ? '△' : '✓'
      const bar = '█'.repeat(Math.min(40, Math.floor(s.count / 10)))
      console.log(`  ${flag} ${name.padEnd(10)} ${String(s.count).padStart(4)}  w2=${String(s.w2).padStart(3)} w1=${String(s.w1).padStart(3)}  ${bar}`)
    }
    console.log()
  }

  // ── 2. 空 tag ──────────────────────────────────────────
  const empty = Object.entries(tagStats).filter(([_, s]) => s.count === 0).map(([n]) => n)
  if (empty.length > 0) {
    console.log('═══ 2. 仍空的 tag ═══')
    for (const n of empty) console.log(`  ✗ ${n}（${tagStats[n].category}）`)
    console.log()
  }

  // ── 3. 沒有任何 mood/style tag 的電影 ─────────────────
  const noMoodStyle = []
  for (const m of movies) {
    const has = (m.tags ?? []).some(tj => {
      const cat = tj.tags_id?.category
      return cat === '情緒' || cat === '風格'
    })
    if (!has) noMoodStyle.push(m)
  }
  console.log(`═══ 3. 完全沒有 mood/style tag 的電影：${noMoodStyle.length} 部 ═══`)
  console.log('（純類型片如純動作可以是合理的）')
  for (const m of noMoodStyle.slice(0, 20)) {
    const types = (m.tags ?? []).filter(tj => tj.tags_id?.category === '類型').map(tj => tj.tags_id.name).join('、')
    console.log(`  《${m.title}》(${m.year}) [${types || '無'}]`)
  }
  if (noMoodStyle.length > 20) console.log(`  ... 還有 ${noMoodStyle.length - 20} 部`)
  console.log()

  // ── 4. 各 mood/style tag 抽樣（spot check）─────────────
  console.log(`═══ 4. mood/style tag 抽樣（每 tag 隨機 ${SAMPLE} 部）═══\n`)
  const moodStyleTags = Object.entries(tagStats)
    .filter(([_, s]) => s.category === '情緒' || s.category === '風格')
    .sort((a, b) => a[0].localeCompare(b[0]))
  for (const [name, s] of moodStyleTags) {
    if (s.count === 0) continue
    const pool = [...s.samples]
    const picked = []
    for (let i = 0; i < SAMPLE && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length)
      picked.push(pool.splice(idx, 1)[0])
    }
    console.log(`  ${name.padEnd(10)} (${s.count}) ${picked.join('、')}`)
  }
  console.log()

  // ── 5. 過度標的電影（mood+style ≥ 6）──────────────────
  const overLabeled = []
  for (const m of movies) {
    const moodStyleCount = (m.tags ?? []).filter(tj => {
      const cat = tj.tags_id?.category
      return cat === '情緒' || cat === '風格'
    }).length
    if (moodStyleCount >= 6) overLabeled.push({m, count: moodStyleCount})
  }
  overLabeled.sort((a, b) => b.count - a.count)
  console.log(`═══ 5. mood/style tag 過多（≥6 個）：${overLabeled.length} 部 ═══`)
  for (const {m, count} of overLabeled.slice(0, 10)) {
    const moodStyle = (m.tags ?? []).filter(tj => tj.tags_id?.category !== '類型').map(tj => `${tj.tags_id?.name}(${tj.weight})`).join('、')
    console.log(`  《${m.title}》(${m.year}) ${count} 個：${moodStyle}`)
  }
  console.log()

  // ── 6. 整體統計 ───────────────────────────────────────
  let totalMoodStyle = 0, totalGenre = 0
  for (const m of movies) {
    for (const tj of m.tags ?? []) {
      const cat = tj.tags_id?.category
      if (cat === '類型') totalGenre++
      else if (cat === '情緒' || cat === '風格') totalMoodStyle++
    }
  }
  console.log('═══ 6. 整體 ═══')
  console.log(`  類型 tag 關聯數：${totalGenre}（平均每片 ${(totalGenre/movies.length).toFixed(1)}）`)
  console.log(`  mood/style tag 關聯數：${totalMoodStyle}（平均每片 ${(totalMoodStyle/movies.length).toFixed(1)}）`)
  console.log(`  完全沒 mood/style 的片：${noMoodStyle.length} / ${movies.length}（${(noMoodStyle.length/movies.length*100).toFixed(1)}%）`)
}

main().catch(err => { console.error(err); process.exit(1) })
