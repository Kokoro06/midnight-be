// migrate-posters-to-directus.mjs
// 目標：把 movies.poster_url（TMDB CDN URL）下載進 Directus assets，把 movies.poster 設為新 file UUID、poster_url 清空。
// 解決：TMDB 沒送 Vary:Origin，分享/截圖時 CORS cache 容易被可見 img 的 opaque response 污染，html2canvas 抓不到海報。
//
// 設計：
//   - 用 Directus POST /files/import 讓 server-side 下載 URL，不用 stream 經本機（Droplet 一條 outbound 解決）
//   - idempotent：預設只處理「poster_url 非 null 且 poster null」的，--refresh 才會重抓已有 poster 的
//   - 進度檔：tmp/migrate-posters-processed-{local|prod}.txt，本機 / 正式區分開
//   - rate limit：每筆 300ms 間隔（Directus + TMDB 都不會抱怨）
//
// 執行：
//   # 本機（從 midnight-be/.env 讀 ADMIN_EMAIL / ADMIN_PASSWORD）
//   node midnight-be/scripts/migrate-posters-to-directus.mjs --dry-run --limit=3
//   node midnight-be/scripts/migrate-posters-to-directus.mjs --limit=50
//   node midnight-be/scripts/migrate-posters-to-directus.mjs
//
//   # 正式區
//   PROD_ADMIN_EMAIL=... PROD_ADMIN_PASSWORD=... \
//     node midnight-be/scripts/migrate-posters-to-directus.mjs --prod --dry-run --limit=3
//   PROD_ADMIN_EMAIL=... PROD_ADMIN_PASSWORD=... \
//     node midnight-be/scripts/migrate-posters-to-directus.mjs --prod
//
//   旗標：
//     --prod              改打 https://mmoodvie.live（預設 http://localhost:8055）
//     --dry-run           只列要做什麼，不真的 import / PATCH
//     --refresh           已有 poster 的也重抓（會嘗試刪掉舊 file，避免孤兒）
//     --reset             清空當前環境的進度檔
//     --limit=N           最多處理 N 部
//     --folder=<uuid>     上傳到指定 Directus folder UUID（可選，整理用）

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
const PROD = process.argv.includes('--prod')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '99999')
const FOLDER = process.argv.find(a => a.startsWith('--folder='))?.split('=')[1] ?? null

const BASE = PROD ? (process.env.PROD_DIRECTUS_URL ?? 'https://mmoodvie.live') : 'http://localhost:8055'
const EMAIL = PROD ? process.env.PROD_ADMIN_EMAIL : env.ADMIN_EMAIL
const PASSWORD = PROD ? process.env.PROD_ADMIN_PASSWORD : env.ADMIN_PASSWORD
const PROGRESS_FILE = join(__dirname, '..', 'tmp', `migrate-posters-processed-${PROD ? 'prod' : 'local'}.txt`)
const INTERVAL_MS = 300

if (!EMAIL || !PASSWORD) {
  console.error(`❌ 缺少 ${PROD ? 'PROD_ADMIN_EMAIL / PROD_ADMIN_PASSWORD（請 export）' : 'midnight-be/.env 的 ADMIN_EMAIL / ADMIN_PASSWORD'}`)
  process.exit(1)
}

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
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
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

async function directus(method, path, body) {
  const token = await ensureToken()
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (r.status === 204) return { data: null }
  return r.json()
}

// 用 /files/import 讓 Directus server-side 抓 URL → 存進 storage。
// 回傳 { data: { id, ... } } 或 { errors: [...] }。
async function importFromUrl(url, title) {
  const token = await ensureToken()
  const r = await fetch(`${BASE}/files/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      data: { title, ...(FOLDER ? { folder: FOLDER } : {}) },
    }),
  })
  return r.json()
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log(`🎯 target: ${BASE}${DRY_RUN ? ' (dry-run)' : ''}${REFRESH ? ' (refresh)' : ''}${FOLDER ? ` folder=${FOLDER}` : ''}`)
  const processed = loadProgress()
  console.log(`📂 進度檔已處理: ${processed.size} 部`)

  const filter = REFRESH
    ? { poster_url: { _nnull: true } }
    : { _and: [{ poster_url: { _nnull: true } }, { poster: { _null: true } }] }
  const filterQS = encodeURIComponent(JSON.stringify(filter))
  const listRes = await directus('GET', `/items/movies?filter=${filterQS}&fields=id,title,poster,poster_url&limit=-1`)
  if (listRes.errors) {
    console.error('❌ 取電影清單失敗', listRes.errors)
    process.exit(1)
  }
  const movies = listRes.data ?? []
  console.log(`📋 待處理: ${movies.length} 部`)

  let migrated = 0, skipped = 0, errors = 0
  for (const m of movies) {
    if (migrated + errors >= LIMIT) break
    if (!REFRESH && processed.has(m.id)) { skipped++; continue }
    if (!m.poster_url) { skipped++; continue }

    if (DRY_RUN) {
      console.log(`  · DRY ${m.title}: ${m.poster_url}`)
      migrated++
      continue
    }

    try {
      // --refresh：先刪舊 file，避免孤兒（失敗就算了，繼續做新的）
      if (REFRESH && m.poster) {
        const del = await directus('DELETE', `/files/${m.poster}`)
        if (del.errors) console.warn(`  ⚠ 舊 file 刪除失敗 ${m.title}:`, del.errors[0]?.message)
      }

      const imp = await importFromUrl(m.poster_url, `${m.title} poster`)
      if (imp.errors || !imp.data?.id) {
        console.error(`  ✗ import 失敗 ${m.title}:`, imp.errors?.[0]?.message ?? JSON.stringify(imp).slice(0, 200))
        errors++
        await sleep(INTERVAL_MS)
        continue
      }
      const fileId = imp.data.id

      const patch = await directus('PATCH', `/items/movies/${m.id}`, {
        poster: fileId,
        poster_url: null,
      })
      if (patch.errors) {
        console.error(`  ✗ PATCH movie 失敗 ${m.title}:`, patch.errors[0]?.message)
        // 已上傳但沒接回 movie → 嘗試刪新 file，避免孤兒
        await directus('DELETE', `/files/${fileId}`).catch(() => {})
        errors++
        await sleep(INTERVAL_MS)
        continue
      }

      markProcessed(m.id)
      migrated++
      if (migrated <= 10 || migrated % 50 === 0) {
        console.log(`  ✓ ${migrated}/${movies.length} ${m.title} → ${fileId.slice(0, 8)}…`)
      }
    } catch (err) {
      console.error(`  ✗ 例外 ${m.title}:`, err.message)
      errors++
    }

    await sleep(INTERVAL_MS)
  }

  console.log(`\n✅ 完成。遷移: ${migrated}  跳過: ${skipped}  錯誤: ${errors}`)
  console.log(`進度檔: ${PROGRESS_FILE}`)
  console.log(`\n驗證: curl "${BASE}/items/movies?filter%5Bposter%5D%5B_nnull%5D=true&aggregate%5Bcount%5D=*"`)
}

main().catch(err => {
  console.error('執行失敗:', err)
  process.exit(1)
})
