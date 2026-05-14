// backfill-overview-providers.mjs
// 對所有 movies：search TMDB → 取 tmdb_id / overview / watch_providers TW link → PATCH 回 Directus
//
// 執行：
//   node midnight-be/scripts/backfill-overview-providers.mjs --dry-run --limit=10
//   node midnight-be/scripts/backfill-overview-providers.mjs --limit=50
//   node midnight-be/scripts/backfill-overview-providers.mjs
//   node midnight-be/scripts/backfill-overview-providers.mjs --refresh  # 已有 tmdb_id 也重抓
//
// 設計：
//   - 預設 idempotent：有 tmdb_id 的跳過（除非 --refresh）
//   - TMDB rate limit：~4 req/sec；每部 2 calls (search + watch/providers) → 配 250ms 間隔
//   - 進度檔：tmp/backfill-overview-processed.txt（每筆寫一行 movie.id）
//   - --reset 清空進度檔

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf-8')
    .split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const DRY_RUN = process.argv.includes('--dry-run')
const REFRESH = process.argv.includes('--refresh')
const RESET = process.argv.includes('--reset')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '99999')

const BASE = 'http://localhost:8055'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_KEY = env.TMDB_API_KEY
const PROGRESS_FILE = join(__dirname, '..', 'tmp', 'backfill-overview-processed.txt')
const TMDB_INTERVAL_MS = 260

if (!TMDB_KEY) { console.error('❌ 缺少 TMDB_API_KEY'); process.exit(1) }

// ── Progress ──────────────────────────────────────────────
function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return new Set()
  return new Set(readFileSync(PROGRESS_FILE, 'utf-8').split('\n').filter(Boolean))
}
function markProcessed(id) {
  mkdirSync(dirname(PROGRESS_FILE), { recursive: true })
  appendFileSync(PROGRESS_FILE, id + '\n')
}
if (RESET && existsSync(PROGRESS_FILE)) {
  writeFileSync(PROGRESS_FILE, '')
  console.log('🔄 進度檔已清空')
}

// ── Directus auth ─────────────────────────────────────────
let _token = null
let _loginAt = 0
const TOKEN_REFRESH_MS = 12 * 60 * 1000

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  }).then(r => r.json())
  if (!r.data?.access_token) { console.error('❌ Directus 登入失敗', r); process.exit(1) }
  return r.data.access_token
}

async function ensureToken() {
  if (!_token || Date.now() - _loginAt > TOKEN_REFRESH_MS) {
    _token = await login()
    _loginAt = Date.now()
  }
  return _token
}

async function dirAuth(method, path, body) {
  const tok = await ensureToken()
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json())
  if (r.errors?.[0]?.extensions?.code === 'TOKEN_EXPIRED') {
    _token = await login()
    _loginAt = Date.now()
    return dirAuth(method, path, body)
  }
  return r
}

// ── TMDB ──────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function tmdbSearch(originalTitle, title, year) {
  const tryQuery = async (q) => {
    const url = `${TMDB_BASE}/search/movie?query=${encodeURIComponent(q)}&year=${year}&language=zh-TW&api_key=${TMDB_KEY}`
    return fetch(url).then(r => r.json())
  }
  let data = await tryQuery(originalTitle || title)
  if (!data.results?.[0] && originalTitle && originalTitle !== title) {
    await sleep(TMDB_INTERVAL_MS)
    data = await tryQuery(title)
  }
  return data.results?.[0] ?? null
}

async function tmdbDetailsZh(tmdbId) {
  // 用 details 拿正確 zh-TW overview（search 結果偶爾是英文）
  const url = `${TMDB_BASE}/movie/${tmdbId}?language=zh-TW&api_key=${TMDB_KEY}`
  return fetch(url).then(r => r.json())
}

async function tmdbDetailsEn(tmdbId) {
  const url = `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_KEY}`
  return fetch(url).then(r => r.json())
}

async function tmdbProvidersTW(tmdbId) {
  const url = `${TMDB_BASE}/movie/${tmdbId}/watch/providers?api_key=${TMDB_KEY}`
  const data = await fetch(url).then(r => r.json())
  return data.results?.TW?.link ?? null
}

// 卡片顯示 3 行截斷；DB 存 200 字內供未來展開顯示
const OVERVIEW_MAX = 200

function normalizeOverview(text) {
  if (!text) return null
  // 換行壓單行（卡片不適合多段）；多空白縮成一格
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  if (cleaned.length <= OVERVIEW_MAX) return cleaned
  // 截斷時往前找到最近的標點，避免切到一半的詞
  const cut = cleaned.slice(0, OVERVIEW_MAX)
  const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf('.'))
  return (lastPunct > OVERVIEW_MAX * 0.7 ? cut.slice(0, lastPunct + 1) : cut) + '…'
}

async function fetchAllForMovie(movie) {
  const hit = await tmdbSearch(movie.original_title, movie.title, movie.year)
  if (!hit) return { tmdb_id: null, overview: null, justwatch_url: null }

  await sleep(TMDB_INTERVAL_MS)
  let overview = hit.overview?.trim() || null
  // search 拿到的 overview 偶爾是英文（zh-TW 落空時 fallback）→ 用 details zh-TW 二次確認
  if (!overview) {
    const zh = await tmdbDetailsZh(hit.id)
    overview = zh.overview?.trim() || null
    await sleep(TMDB_INTERVAL_MS)
    if (!overview) {
      const en = await tmdbDetailsEn(hit.id)
      overview = en.overview?.trim() || null
      await sleep(TMDB_INTERVAL_MS)
    }
  }

  const link = await tmdbProvidersTW(hit.id)
  return { tmdb_id: hit.id, overview: normalizeOverview(overview), justwatch_url: link }
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log('🔐 登入 Directus...')
  await ensureToken()

  console.log('📚 撈 movies...')
  const filter = REFRESH ? '' : '&filter[tmdb_id][_null]=true'
  const res = await dirAuth('GET', `/items/movies?limit=-1&fields=id,title,original_title,year,tmdb_id,overview,justwatch_url${filter}`)
  const allMovies = res.data ?? []

  const processed = loadProgress()
  const todo = allMovies.filter(m => !processed.has(m.id)).slice(0, LIMIT)
  console.log(`📊 總計 ${allMovies.length} 部；已處理 ${processed.size} 部；本次處理 ${todo.length} 部${DRY_RUN ? '（dry-run）' : ''}`)
  if (todo.length === 0) { console.log('✅ 無待處理'); return }

  let ok = 0, miss = 0, fail = 0
  const startedAt = Date.now()

  for (let i = 0; i < todo.length; i++) {
    const m = todo[i]
    const idx = `[${i + 1}/${todo.length}]`
    try {
      const { tmdb_id, overview, justwatch_url } = await fetchAllForMovie(m)
      if (!tmdb_id) {
        miss++
        console.log(`${idx} ⊘ TMDB 找不到：${m.title} (${m.year})`)
      } else {
        ok++
        const trunc = overview ? overview.slice(0, 50).replace(/\n/g, ' ') + (overview.length > 50 ? '…' : '') : '(無)'
        const linkFlag = justwatch_url ? '✓link' : '✗link'
        console.log(`${idx} ✓ ${m.title} → tmdb#${tmdb_id} ${linkFlag} | ${trunc}`)
        if (!DRY_RUN) {
          const patch = await dirAuth('PATCH', `/items/movies/${m.id}`, { tmdb_id, overview, justwatch_url })
          if (patch.errors) { fail++; console.error(`    ✗ PATCH 失敗：`, JSON.stringify(patch.errors)) }
        }
      }
      if (!DRY_RUN) markProcessed(m.id)
    } catch (e) {
      fail++
      console.error(`${idx} ✗ ${m.title}：`, e.message)
    }
    await sleep(TMDB_INTERVAL_MS)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\n✅ 完成：成功 ${ok} / 找不到 ${miss} / 失敗 ${fail}（${elapsed}s）`)
}

main().catch(e => { console.error(e); process.exit(1) })
