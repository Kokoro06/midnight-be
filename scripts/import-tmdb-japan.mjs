// import-tmdb-japan.mjs — 從 TMDB 批次匯入「日本電影」到 prod
// 條件：
//   - with_original_language=ja
//   - 排除 Animation (genre 16)
//   - 排除動畫/漫畫改編真人化（透過 /movie/{id}/keywords 過濾）
//   - 評分 ≥6.5、票數 ≥100、近 20 年
//
// 執行：
//   node midnight-be/scripts/import-tmdb-japan.mjs --dry-run
//   node midnight-be/scripts/import-tmdb-japan.mjs
//
// 需要 .env：
//   TMDB_API_KEY=...
//   PROD_ADMIN_EMAIL=...
//   PROD_ADMIN_PASSWORD=...
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
const BASE = 'https://mmoodvie.live'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_KEY = env.TMDB_API_KEY
const ADMIN_EMAIL = env.PROD_ADMIN_EMAIL
const ADMIN_PASSWORD = env.PROD_ADMIN_PASSWORD

if (!TMDB_KEY) {
  console.error('❌ 缺少 TMDB_API_KEY')
  process.exit(1)
}
if (!DRY_RUN && (!ADMIN_EMAIL || !ADMIN_PASSWORD)) {
  console.error('❌ 缺少 PROD_ADMIN_EMAIL / PROD_ADMIN_PASSWORD（dry-run 不需要）')
  process.exit(1)
}

// ── 與 import-tmdb.mjs 一致的 TMDB Genre → Directus Tag 對照 ──
const GENRE_TAG_MAP = {
  28:    { primary: '動作',       secondary: [] },
  12:    { primary: '冒險',       secondary: [] },
  16:    { primary: '奇幻',       secondary: ['需要被療癒'] },
  35:    { primary: '喜劇',       secondary: ['靜靜看就好', '躺著看就好'] },
  80:    { primary: '犯罪',       secondary: ['社會'] },
  99:    { primary: '紀錄片',     secondary: ['靜靜看就好'] },
  18:    { primary: '劇情',       secondary: ['好想哭', '有點寂寞'] },
  10751: { primary: '暖暖的就好', secondary: ['需要被療癒', '靜靜看就好'] },
  14:    { primary: '奇幻',       secondary: ['冒險'] },
  36:    { primary: '社會',       secondary: ['政治', '想念那時候'] },
  27:    { primary: '驚悚',       secondary: ['想看點怪的'] },
  10402: { primary: '文藝',       secondary: ['需要被療癒'] },
  9648:  { primary: '懸疑',       secondary: ['越燒越好'] },
  10749: { primary: '想談戀愛',   secondary: ['心動的感覺'] },
  878:   { primary: '科幻',       secondary: ['越燒越好', '世界毀了也無所謂'] },
  53:    { primary: '驚悚',       secondary: ['懸疑', '越燒越好'] },
  10752: { primary: '戰爭',       secondary: [] },
  37:    { primary: '冒險',       secondary: [] },
}

// 排除這些關鍵字（名稱小寫比對，substring match）
const EXCLUDE_KEYWORDS = ['anime', 'manga', 'live action remake', 'live-action remake']

// 白名單 TMDB ID：
// - 即使含 EXCLUDE_KEYWORDS 也放行（不被 keyword 過濾踢除）
// - 若不在 discover 結果裡（未達評分/票數門檻），強制注入候選清單
const WHITELIST_IDS = [
  315846,   // 海街日記（是枝裕和 2015，原作為吉田秋生漫畫）
  1070507,  // 去唱卡拉OK吧！（山下敦弘 2024，原作為山本さほ漫畫）
]

const YEAR_FROM = new Date().getFullYear() - 20
const PAGES = 10  // 每 pass 抓 10 頁 ≈ 200 筆上限

// 三層抓取策略：
//   Pass A 主流：vote_count≥100、vote_avg≥6.5
//   Pass B 小眾擇優：vote_count 30~99、vote_avg≥7.0（票少就要評分更亮）
//   Pass C 藝文導演：with_people 命中 AUTEUR_IDS、vote_count≥30、不設 vote_avg、不設年份
const PASS_A = { vote_count_gte: 100, vote_count_lte: null, vote_avg_gte: 6.5 }
const PASS_B = { vote_count_gte: 30,  vote_count_lte: 99,   vote_avg_gte: 7.0 }
const AUTEUR_VOTE_COUNT_MIN = 30
const AUTEUR_IDS = [
  25645,    // 是枝裕和 Hirokazu Kore-eda
  1487492,  // 濱口竜介 Ryusuke Hamaguchi
  20658,    // 河瀨直美 Naomi Kawase
  26882,    // 黒沢清 Kiyoshi Kurosawa
  3317,     // 北野武 Takeshi Kitano
  55785,    // 岩井俊二 Shunji Iwai
  133914,   // 西川美和 Miwa Nishikawa
  2223841,  // 三宅唱 Sho Miyake
  583881,   // 山下敦弘 Nobuhiro Yamashita
  72496,    // 山田洋次 Yoji Yamada
  67075,    // 園子温 Sion Sono
]

// ── Directus helpers ──────────────────────────────────────

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
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

const hasCJK = (str) => /[⺀-鿿豈-﫿]/.test(str)

async function getChineseTitle(tmdbId) {
  try {
    const data = await tmdb(`/movie/${tmdbId}?language=zh-TW`)
    const title = data.title || null
    return title && hasCJK(title) ? title : null
  } catch {
    return null
  }
}

async function getKeywords(tmdbId) {
  try {
    const data = await tmdb(`/movie/${tmdbId}/keywords`)
    return (data.keywords ?? []).map(k => (k.name || '').toLowerCase())
  } catch {
    return []
  }
}

function matchesExcludedKeyword(keywords) {
  for (const k of keywords) {
    for (const ex of EXCLUDE_KEYWORDS) {
      if (k.includes(ex)) return ex
    }
  }
  return null
}

// 強制注入：用 /movie/{id} 取單部片，正規化為 discover 結果的 shape
async function fetchMovieById(tmdbId) {
  try {
    const data = await tmdb(`/movie/${tmdbId}?language=zh-TW`)
    return {
      id: data.id,
      original_title: data.original_title,
      release_date: data.release_date,
      vote_average: data.vote_average,
      poster_path: data.poster_path,
      genre_ids: (data.genres ?? []).map(g => g.id),
    }
  } catch {
    return null
  }
}

// 通用 discover pass（日語、排動畫；vote/年份/with_people 由 opts 控制）
async function fetchDiscoverPass({ label, vote_count_gte, vote_count_lte, vote_avg_gte, with_people, use_year_filter = true }) {
  const movies = []
  for (let page = 1; page <= PAGES; page++) {
    const params = [
      `with_original_language=ja`,
      `without_genres=16`,
      `sort_by=vote_average.desc`,
      `language=zh-TW`,
      `page=${page}`,
    ]
    if (use_year_filter) params.push(`primary_release_date.gte=${YEAR_FROM}-01-01`)
    if (vote_count_gte != null) params.push(`vote_count.gte=${vote_count_gte}`)
    if (vote_count_lte != null) params.push(`vote_count.lte=${vote_count_lte}`)
    if (vote_avg_gte != null)   params.push(`vote_average.gte=${vote_avg_gte}`)
    if (with_people)            params.push(`with_people=${with_people}`)

    const data = await tmdb(`/discover/movie?${params.join('&')}`)
    if (!data.results?.length) break
    movies.push(...data.results)
    if (data.results.length < 20 || page >= data.total_pages) break
    await new Promise(r => setTimeout(r, 300))
  }
  return movies
}

// 三 pass merge + dedupe；同一部片以最先見到的 _source 為準
async function fetchJapaneseMovies() {
  const seen = new Set()
  const all = []
  function addBatch(arr, source) {
    let n = 0
    for (const m of arr) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      all.push({ ...m, _source: source })
      n++
    }
    return n
  }

  console.log('  Pass A: 主流（票數≥100、評分≥6.5）...')
  const a = await fetchDiscoverPass({ label: 'A', ...PASS_A })
  console.log(`    +${addBatch(a, 'A')} 部新增（pass 共抓 ${a.length}）`)

  console.log('  Pass B: 小眾擇優（票數 30~99、評分≥7.0）...')
  const b = await fetchDiscoverPass({ label: 'B', ...PASS_B })
  console.log(`    +${addBatch(b, 'B')} 部新增（pass 共抓 ${b.length}）`)

  console.log(`  Pass C: 藝文導演（${AUTEUR_IDS.length} 位、票數≥${AUTEUR_VOTE_COUNT_MIN}、不限年份）...`)
  const c = await fetchDiscoverPass({
    label: 'C',
    with_people: AUTEUR_IDS.join('|'),
    vote_count_gte: AUTEUR_VOTE_COUNT_MIN,
    use_year_filter: false,
  })
  console.log(`    +${addBatch(c, 'C')} 部新增（pass 共抓 ${c.length}）`)

  return all
}

// ── Tag weight 計算 ───────────────────────────────────────

function buildTagWeights(tmdbGenreIds) {
  const tagWeights = {}
  tmdbGenreIds.forEach((genreId, index) => {
    const mapping = GENRE_TAG_MAP[genreId]
    if (!mapping) return
    const isPrimary = index === 0
    const primaryWeight = isPrimary ? 2.0 : 1.0
    const existing = tagWeights[mapping.primary]
    tagWeights[mapping.primary] = Math.max(existing ?? 0, primaryWeight)
    for (const secTag of mapping.secondary) {
      if (!tagWeights[secTag]) tagWeights[secTag] = 1.0
    }
  })
  return tagWeights
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  console.log(`🎯 目標：${BASE}`)
  if (DRY_RUN) console.log('🔍 DRY RUN 模式 — 不寫入 Directus\n')

  let token = null
  if (!DRY_RUN) {
    console.log('🔐 登入 prod Directus...')
    token = await login()
    console.log('  ✓ 登入成功\n')
  }

  console.log('📌 取得現有 tags...')
  const { data: existingTags } = DRY_RUN
    ? { data: [] }
    : await directus(token, 'GET', '/items/tags?limit=-1').catch(() => ({ data: [] }))
  const tagMap = Object.fromEntries((existingTags ?? []).map(t => [t.name, t.id]))
  if (!DRY_RUN) console.log(`  ✓ ${Object.keys(tagMap).length} 個 tag\n`)

  console.log('🎬 取得現有 movies...')
  const { data: existingMovies } = DRY_RUN
    ? { data: [] }
    : await directus(token, 'GET', '/items/movies?limit=-1&fields=id,title,original_title,year').catch(() => ({ data: [] }))
  const existingByOrigTitle = {}
  const existingByZhYear = {}
  for (const m of existingMovies ?? []) {
    if (m.original_title) existingByOrigTitle[m.original_title.toLowerCase()] = m.id
    if (m.title && m.year) existingByZhYear[`${m.title}|${m.year}`] = m.id
  }
  if (!DRY_RUN) console.log(`  ✓ ${(existingMovies ?? []).length} 部現有電影\n`)

  console.log(`🌐 從 TMDB 抓日本電影（3 pass、每 pass 最多 ${PAGES} 頁）...`)
  const allMovies = await fetchJapaneseMovies()
  const sourceCounts = allMovies.reduce((acc, m) => { acc[m._source] = (acc[m._source] ?? 0) + 1; return acc }, {})
  console.log(`  共 ${allMovies.length} 部候選（去重後） ${JSON.stringify(sourceCounts)}\n`)

  if (WHITELIST_IDS.length) {
    console.log(`📌 處理白名單 ${WHITELIST_IDS.length} 部（未在候選清單者強制注入）...`)
    const existingIds = new Set(allMovies.map(m => m.id))
    for (const id of WHITELIST_IDS) {
      if (existingIds.has(id)) {
        console.log(`  · 已在候選清單: TMDB ${id}`)
        continue
      }
      const m = await fetchMovieById(id)
      await new Promise(r => setTimeout(r, 200))
      if (m) {
        allMovies.push(m)
        console.log(`  + 注入: ${m.original_title} (${m.release_date?.slice(0, 4)}) ★${m.vote_average?.toFixed(1)}`)
      } else {
        console.log(`  ✗ 抓取失敗: TMDB ${id}`)
      }
    }
    console.log('')
  }

  console.log('🔎 過濾動畫/漫畫改編真人化（逐片查 keywords）...')
  const filtered = []
  let excludedCount = 0
  for (const movie of allMovies) {
    if (WHITELIST_IDS.includes(movie.id)) {
      filtered.push(movie)
      console.log(`  ✓ 白名單放行: ${movie.original_title}`)
      continue
    }
    const keywords = await getKeywords(movie.id)
    await new Promise(r => setTimeout(r, 200))
    const hit = matchesExcludedKeyword(keywords)
    if (hit) {
      excludedCount++
      if (excludedCount <= 10) {
        console.log(`  ⊘ 排除「${movie.original_title}」(${movie.release_date?.slice(0, 4)}) — keyword: ${hit}`)
      }
      continue
    }
    filtered.push(movie)
  }
  console.log(`  剩 ${filtered.length} 部（排除 ${excludedCount} 部）\n`)

  if (DRY_RUN) {
    const tagCoverage = {}
    for (const movie of filtered) {
      const weights = buildTagWeights(movie.genre_ids ?? [])
      for (const tag of Object.keys(weights)) {
        tagCoverage[tag] = (tagCoverage[tag] ?? 0) + 1
      }
    }
    console.log('📊 Tag coverage 預估:')
    Object.entries(tagCoverage)
      .sort((a, b) => b[1] - a[1])
      .forEach(([tag, count]) => console.log(`  ${tag.padEnd(10)} ${count}`))

    console.log('\n📋 前 20 部預覽:')
    for (const m of filtered.slice(0, 20)) {
      const weights = buildTagWeights(m.genre_ids ?? [])
      const tagStr = Object.entries(weights).map(([t, w]) => `${t}(${w})`).join(', ')
      const src = m._source ? `[${m._source}]` : '[W]'
      console.log(`  ${src} ${m.original_title} (${m.release_date?.slice(0, 4)}) ★${m.vote_average?.toFixed(1)} → ${tagStr}`)
    }
    console.log('\n✅ Dry-run 完成。確認後執行 node midnight-be/scripts/import-tmdb-japan.mjs 正式匯入。')
    return
  }

  console.log('📥 開始匯入到 prod...')
  let created = 0, updated = 0, skipped = 0, errors = 0

  for (const movie of filtered) {
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

    const zhTitle = await getChineseTitle(movie.id)
    await new Promise(r => setTimeout(r, 250))

    if (!zhTitle) {
      skipped++
      if (skipped <= 10) console.log(`  ⊘ 無中譯跳過: ${origTitle}`)
      continue
    }

    const year = parseInt(movie.release_date?.slice(0, 4) ?? '0')
    if (!existingId && year > 0) {
      existingId =
        existingByZhYear[`${zhTitle}|${year}`] ||
        existingByZhYear[`${zhTitle}|${year - 1}`] ||
        existingByZhYear[`${zhTitle}|${year + 1}`]
      if (existingId) console.log(`  ⤷ 中譯片名比對到已存在《${zhTitle}》(${year})，改為更新`)
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
  console.log(`\n驗證: curl "${BASE}/items/movies?fields=title,year,original_title&filter[original_title][_regex]=^.*$&limit=5&sort=-date_created"`)
}

main().catch(err => {
  console.error('執行失敗:', err)
  process.exit(1)
})
