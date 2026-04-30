// clean-superhero.mjs — 刪除好萊塢超級英雄電影
// 使用 TMDB keyword "superhero" 與 "marvel cinematic universe" 判斷
// 執行: node midnight-be/scripts/clean-superhero.mjs [--dry-run]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf-8')
    .split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const DRY_RUN = process.argv.includes('--dry-run')
const BASE = 'http://localhost:8055'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_KEY = env.TMDB_API_KEY

if (!TMDB_KEY) { console.error('❌ 缺少 TMDB_API_KEY'); process.exit(1) }

async function login() {
  const body = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  }).then(r => r.json())
  if (!body.data?.access_token) { console.error('登入失敗'); process.exit(1) }
  return body.data.access_token
}

async function directusApi(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204 || res.headers.get('content-length') === '0') return {}
  return res.json()
}

async function tmdbGet(path) {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${TMDB_BASE}${path}${sep}api_key=${TMDB_KEY}`)
  if (!res.ok) return null
  return res.json()
}

async function searchTmdb(originalTitle, year) {
  const q = encodeURIComponent(originalTitle)
  const data = await tmdbGet(`/search/movie?query=${q}&year=${year}`)
  return data?.results?.[0] ?? null
}

async function findKeywordId(query) {
  const data = await tmdbGet(`/search/keyword?query=${encodeURIComponent(query)}`)
  return data?.results?.find(k => k.name.toLowerCase() === query.toLowerCase())?.id ?? null
}

async function getMovieKeywords(tmdbId) {
  const data = await tmdbGet(`/movie/${tmdbId}/keywords`)
  return (data?.keywords ?? []).map(k => k.id)
}

async function main() {
  if (DRY_RUN) console.log('🔍 DRY RUN 模式 — 不會真正刪除\n')

  console.log('🔐 登入 Directus...')
  const token = await login()
  console.log('  ✓ 登入成功\n')

  // 動態查詢 TMDB keyword IDs
  console.log('🏷  查詢超英 keyword IDs...')
  const [superheroId, mcuId] = await Promise.all([
    findKeywordId('superhero'),
    findKeywordId('marvel cinematic universe'),
  ])
  console.log(`  superhero       → ${superheroId ?? '未找到'}`)
  console.log(`  marvel cinematic universe → ${mcuId ?? '未找到'}`)
  const superheroKeywords = new Set([superheroId, mcuId].filter(Boolean))
  console.log()

  const { data: movies } = await directusApi(token, 'GET',
    '/items/movies?limit=-1&fields=id,title,original_title,year')
  console.log(`📦 共 ${movies.length} 部電影待檢查\n`)

  const toDelete = []

  for (const movie of movies) {
    const searchTitle = movie.original_title || movie.title
    await new Promise(r => setTimeout(r, 250))

    const hit = await searchTmdb(searchTitle, movie.year)
    if (!hit) continue

    await new Promise(r => setTimeout(r, 250))
    const keywords = await getMovieKeywords(hit.id)
    const isSuperhero = keywords.some(kid => superheroKeywords.has(kid))

    if (isSuperhero) {
      toDelete.push({ ...movie, tmdbTitle: hit.title })
      process.stdout.write(`  ❌ 標記刪除：《${movie.title}》（${movie.year}）\n`)
    }
  }

  console.log(`\n──────────────────────────────`)
  console.log(`🦸 待刪超英電影：${toDelete.length} 部`)

  if (toDelete.length === 0) {
    console.log('  → 無需刪除')
    return
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 以下電影將被刪除：')
    toDelete.forEach(m => console.log(`  - 《${m.title}》(${m.year})`))
    console.log('\n移除 --dry-run 後重新執行以實際刪除')
    return
  }

  console.log('\n🗑  開始刪除...')
  let deleted = 0, errors = 0
  for (const movie of toDelete) {
    const res = await directusApi(token, 'DELETE', `/items/movies/${movie.id}`)
    if (res?.errors) {
      console.log(`  ✗ 《${movie.title}》: ${res.errors[0]?.message}`)
      errors++
    } else {
      console.log(`  ✓ 已刪除《${movie.title}》`)
      deleted++
    }
  }

  console.log(`\n✅ 完成：刪除 ${deleted} 部，錯誤 ${errors} 部`)
}

main().catch(err => { console.error('執行失敗:', err); process.exit(1) })
