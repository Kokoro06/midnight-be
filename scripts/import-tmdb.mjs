// import-tmdb.mjs — Phase 10-B TMDB 批次匯入
// 執行:
//   node midnight-be/scripts/import-tmdb.mjs [--dry-run]
//   node midnight-be/scripts/import-tmdb.mjs --now-playing [--dry-run]
//     └─ 改抓 /movie/now_playing 當期院線片，不套用評分/票數門檻
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf-8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const DRY_RUN = process.argv.includes('--dry-run')
const NOW_PLAYING = process.argv.includes('--now-playing')
const BASE = 'http://localhost:8055'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_KEY = env.TMDB_API_KEY

if (!TMDB_KEY) {
  console.error('❌ 缺少 TMDB_API_KEY，請在 midnight-be/.env 新增：TMDB_API_KEY=你的key')
  process.exit(1)
}

// ── TMDB Genre → Directus Tag 對照表 ───────────────────────
// primary: 第一個 genre 的主要 tag（weight 2.0）
// secondary: 次要情緒/風格 tag（weight 1.0）
// ⚠️ 所有 tag 名稱必須與 Directus tags collection 一致
const GENRE_TAG_MAP = {
  28:    { primary: '動作',       secondary: [] },
  12:    { primary: '冒險',       secondary: [] },
  16:    { primary: '奇幻',       secondary: ['需要被療癒'] },           // Animation
  35:    { primary: '喜劇',       secondary: ['靜靜看就好', '躺著看就好'] }, // Comedy
  80:    { primary: '犯罪',       secondary: ['社會'] },
  99:    { primary: '紀錄片',     secondary: ['靜靜看就好'] },
  18:    { primary: '劇情',       secondary: ['好想哭', '有點寂寞'] },   // Drama
  10751: { primary: '暖暖的就好', secondary: ['需要被療癒', '靜靜看就好'] }, // Family
  14:    { primary: '奇幻',       secondary: ['冒險'] },                 // Fantasy
  36:    { primary: '社會',       secondary: ['政治', '想念那時候'] },    // History
  27:    { primary: '驚悚',       secondary: ['想看點怪的'] },            // Horror
  10402: { primary: '文藝',       secondary: ['需要被療癒'] },            // Music
  9648:  { primary: '懸疑',       secondary: ['越燒越好'] },              // Mystery
  10749: { primary: '想談戀愛',   secondary: ['心動的感覺'] },            // Romance
  878:   { primary: '科幻',       secondary: ['越燒越好', '世界毀了也無所謂'] }, // Sci-Fi
  53:    { primary: '驚悚',       secondary: ['懸疑', '越燒越好'] },      // Thriller
  10752: { primary: '戰爭',       secondary: [] },
  37:    { primary: '冒險',       secondary: [] },                        // Western
}

// 目標：這些 genre 各拉一批，確保所有主要 tag 有足夠電影
const TARGET_GENRES = [28, 12, 35, 80, 18, 10751, 14, 27, 9648, 10749, 878, 53, 10752, 99, 10402, 36]

const YEAR_FROM = new Date().getFullYear() - 20  // 近 20 年

// ── Directus helpers ──────────────────────────────────────

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  })
  const body = await res.json()
  if (!body.data?.access_token) {
    console.error('Directus 登入失敗:', JSON.stringify(body))
    process.exit(1)
  }
  return body.data.access_token
}

async function directus(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// ── TMDB helpers ──────────────────────────────────────────

async function tmdb(path) {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${TMDB_BASE}${path}${sep}api_key=${TMDB_KEY}`)
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${path}`)
  return res.json()
}

const hasCJK = (str) => /[⺀-鿿豈-﫿]/.test(str)

async function getChineseTitle(tmdbId) {
  try {
    const data = await tmdb(`/movie/${tmdbId}?language=zh-TW`)
    const title = data.title || null
    // 必須包含中文/日文字元，否則視為無中譯
    return title && hasCJK(title) ? title : null
  } catch {
    return null
  }
}

async function fetchMoviesByGenre(genreId, pages = 3) {
  const movies = []
  for (let page = 1; page <= pages; page++) {
    const data = await tmdb(
      `/discover/movie?with_genres=${genreId}` +
      `&primary_release_date.gte=${YEAR_FROM}-01-01` +
      `&vote_average.gte=7.0&vote_count.gte=200` +
      `&sort_by=vote_average.desc` +
      `&language=zh-TW` +
      `&region=TW` +
      `&with_release_type=3|2` +
      `&page=${page}`
    )
    if (!data.results?.length) break
    movies.push(...data.results)
  }
  return movies
}

async function fetchNowPlaying(pages = 3) {
  const movies = []
  for (let page = 1; page <= pages; page++) {
    const data = await tmdb(
      `/movie/now_playing?language=zh-TW&region=TW&page=${page}`
    )
    if (!data.results?.length) break
    movies.push(...data.results)
    await new Promise(r => setTimeout(r, 300))
  }
  return movies
}

// ── Tag weight 計算 ───────────────────────────────────────

function buildTagWeights(tmdbGenreIds) {
  const tagWeights = {}   // tag name → weight

  tmdbGenreIds.forEach((genreId, index) => {
    const mapping = GENRE_TAG_MAP[genreId]
    if (!mapping) return

    const isPrimary = index === 0
    const primaryWeight = isPrimary ? 2.0 : 1.0

    // primary tag
    const existing = tagWeights[mapping.primary]
    tagWeights[mapping.primary] = Math.max(existing ?? 0, primaryWeight)

    // secondary tags (always 1.0, don't override higher weight)
    for (const secTag of mapping.secondary) {
      if (!tagWeights[secTag]) tagWeights[secTag] = 1.0
    }
  })

  return tagWeights  // { '動作': 2.0, '燒腦': 1.0, ... }
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('🔍 DRY RUN 模式 — 不寫入 Directus\n')

  console.log('🔐 登入 Directus...')
  const token = DRY_RUN ? null : await login()
  if (!DRY_RUN) console.log('  ✓ 登入成功\n')

  // 取得現有 tags
  console.log('📌 取得現有 tags...')
  const { data: existingTags } = await directus(token ?? '', 'GET', '/items/tags?limit=-1')
    .catch(() => ({ data: [] }))
  const tagMap = Object.fromEntries((existingTags ?? []).map(t => [t.name, t.id]))
  console.log(`  ✓ ${Object.keys(tagMap).length} 個 tag\n`)

  // 取得現有 movies — 雙鍵 dedupe：original_title 與 title+year（容忍 ±1 年）
  console.log('🎬 取得現有 movies...')
  const { data: existingMovies } = await directus(token ?? '', 'GET', '/items/movies?limit=-1&fields=id,title,original_title,year')
    .catch(() => ({ data: [] }))
  const existingByOrigTitle = {}
  const existingByZhYear = {}  // `${zhTitle}|${year}` → id
  for (const m of existingMovies ?? []) {
    if (m.original_title) existingByOrigTitle[m.original_title.toLowerCase()] = m.id
    if (m.title && m.year) existingByZhYear[`${m.title}|${m.year}`] = m.id
  }
  console.log(`  ✓ ${(existingMovies ?? []).length} 部現有電影（${Object.keys(existingByOrigTitle).length} 有 original_title、${Object.keys(existingByZhYear).length} 有 title+year）\n`)

  // 批次抓 TMDB 電影
  console.log('🌐 從 TMDB 抓片單...')
  const seen = new Set()
  const allMovies = []

  if (NOW_PLAYING) {
    console.log('  模式：當期院線片（/movie/now_playing，不套用評分/票數門檻）')
    const movies = await fetchNowPlaying(3)
    const fresh = movies.filter(m => !seen.has(m.id))
    fresh.forEach(m => seen.add(m.id))
    allMovies.push(...fresh)
    console.log(`  ${fresh.length} 部`)
  } else {
    for (const genreId of TARGET_GENRES) {
      const genreName = GENRE_TAG_MAP[genreId]?.primary ?? genreId
      process.stdout.write(`  genre ${genreId} (${genreName})... `)
      const movies = await fetchMoviesByGenre(genreId)
      const fresh = movies.filter(m => !seen.has(m.id))
      fresh.forEach(m => seen.add(m.id))
      allMovies.push(...fresh.map(m => ({ ...m, _queryGenreId: genreId })))
      console.log(`${fresh.length} 部`)
      await new Promise(r => setTimeout(r, 300))  // rate limit
    }
  }

  console.log(`\n  共 ${allMovies.length} 部候選電影（去重後）\n`)

  // 驗證對照表（dry-run 時印出 tag coverage）
  if (DRY_RUN) {
    const tagCoverage = {}
    for (const movie of allMovies) {
      const weights = buildTagWeights(movie.genre_ids ?? [])
      for (const tag of Object.keys(weights)) {
        tagCoverage[tag] = (tagCoverage[tag] ?? 0) + 1
      }
    }
    console.log('📊 Tag coverage（預估每個 tag 的電影數）:')
    Object.entries(tagCoverage)
      .sort((a, b) => b[1] - a[1])
      .forEach(([tag, count]) => {
        const status = count >= 15 ? '✓' : count >= 10 ? '△' : '✗'
        console.log(`  ${status} ${tag.padEnd(8)} ${count} 部`)
      })

    console.log('\n📋 前 10 部電影預覽:')
    for (const m of allMovies.slice(0, 10)) {
      const weights = buildTagWeights(m.genre_ids ?? [])
      const tagStr = Object.entries(weights).map(([t, w]) => `${t}(${w})`).join(', ')
      console.log(`  ${m.original_title} (${m.release_date?.slice(0, 4)}) ★${m.vote_average.toFixed(1)} → ${tagStr}`)
    }

    console.log('\n✅ Dry-run 完成。確認無誤後執行 node import-tmdb.mjs 正式匯入。')
    return
  }

  // 正式匯入
  console.log('📥 開始匯入...')
  let created = 0, updated = 0, skipped = 0, errors = 0

  for (const movie of allMovies) {
    const origTitle = movie.original_title || ''
    let existingId = existingByOrigTitle[origTitle.toLowerCase()]

    const weights = buildTagWeights(movie.genre_ids ?? [])
    const tagEntries = Object.entries(weights)
      .filter(([name]) => tagMap[name])
      .map(([name, weight]) => ({ tags_id: { id: tagMap[name] }, weight }))

    if (tagEntries.length === 0) {
      skipped++
      continue
    }

    // 取中文片名，無中譯則跳過
    const zhTitle = await getChineseTitle(movie.id)
    await new Promise(r => setTimeout(r, 250))  // rate limit

    if (!zhTitle) {
      skipped++
      if (skipped <= 10) console.log(`  ⊘ 無中譯跳過: ${origTitle}`)
      continue
    }

    const year = parseInt(movie.release_date?.slice(0, 4) ?? '0')

    // 第二層 dedupe：用 zhTitle+year（容忍 ±1 年），抓不同 original_title 寫法的同片
    if (!existingId && year > 0) {
      existingId =
        existingByZhYear[`${zhTitle}|${year}`] ||
        existingByZhYear[`${zhTitle}|${year - 1}`] ||
        existingByZhYear[`${zhTitle}|${year + 1}`]
      if (existingId) {
        console.log(`  ⤷ 中譯片名比對到已存在《${zhTitle}》(${year})，改為更新`)
      }
    }

    const posterUrl = movie.poster_path
      ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
      : null

    const payload = {
      title: zhTitle,
      original_title: origTitle,
      year,
      poster_url: posterUrl,
      tags: tagEntries,
    }

    if (existingId) {
      const res = await directus(token, 'PATCH', `/items/movies/${existingId}`, payload)
      if (res.errors) {
        console.error(`  ✗ 更新失敗 ${origTitle}:`, res.errors[0]?.message)
        errors++
      } else {
        updated++
        if (updated <= 5) console.log(`  ↻ 更新: ${payload.title}`)
      }
    } else {
      const res = await directus(token, 'POST', '/items/movies', payload)
      if (res.errors) {
        console.error(`  ✗ 新增失敗 ${origTitle}:`, res.errors[0]?.message)
        errors++
      } else {
        created++
        if (created <= 5) console.log(`  ✓ 新增: ${payload.title} (${payload.year})`)
      }
    }
  }

  console.log(`\n✅ 匯入完成！`)
  console.log(`   新增: ${created}  更新: ${updated}  跳過: ${skipped}  錯誤: ${errors}`)
  console.log(`\n驗證: curl "http://localhost:8055/items/movies?fields=title,year,tags.tags_id.name,tags.weight&limit=5"`)
}

main().catch(err => {
  console.error('執行失敗:', err)
  process.exit(1)
})
