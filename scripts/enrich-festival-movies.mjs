// enrich-festival-movies.mjs
// 針對 festival_awards 裡無 tags 的電影，用 TMDB 補齊 tags + poster
// 執行: node midnight-be/scripts/enrich-festival-movies.mjs [--dry-run]
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

if (!TMDB_KEY) {
  console.error('❌ 缺少 TMDB_API_KEY，請在 midnight-be/.env 新增')
  process.exit(1)
}

// 與 import-tmdb.mjs 相同的對照表
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

// 影展電影若 TMDB 找不到或無 genre 可對應，使用此 fallback
// key = award_category 或 festival 的部分字串
const FESTIVAL_FALLBACK_TAGS = {
  '紀錄片': ['紀錄片', '靜靜看就好'],
  'TIDF':   ['紀錄片', '靜靜看就好', '文藝'],
  '劇情':   ['劇情', '文藝'],
  'default':['文藝'],
}

function buildTagWeights(genreIds) {
  const tagWeights = {}
  genreIds.forEach((id, index) => {
    const mapping = GENRE_TAG_MAP[id]
    if (!mapping) return
    const isPrimary = index === 0
    const w = isPrimary ? 2.0 : 1.0
    tagWeights[mapping.primary] = Math.max(tagWeights[mapping.primary] ?? 0, w)
    for (const sec of mapping.secondary) {
      if (!tagWeights[sec]) tagWeights[sec] = 1.0
    }
  })
  return tagWeights
}

async function directusApi(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function tmdb(path) {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${TMDB_BASE}${path}${sep}api_key=${TMDB_KEY}`)
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${path}`)
  return res.json()
}

async function searchTMDB(originalTitle, year) {
  try {
    const q = encodeURIComponent(originalTitle)
    const data = await tmdb(`/search/movie?query=${q}&year=${year}&language=zh-TW`)
    return data.results?.[0] ?? null
  } catch {
    return null
  }
}

async function login() {
  const body = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  }).then(r => r.json())
  if (!body.data?.access_token) { console.error('登入失敗'); process.exit(1) }
  return body.data.access_token
}

async function main() {
  if (DRY_RUN) console.log('🔍 DRY RUN 模式\n')

  console.log('🔐 登入 Directus...')
  const token = await login()
  console.log('  ✓ 登入成功\n')

  // 取得現有 tags
  const { data: existingTags } = await directusApi(token, 'GET', '/items/tags?limit=-1')
  const tagMap = Object.fromEntries((existingTags ?? []).map(t => [t.name, t.id]))
  console.log(`📌 ${Object.keys(tagMap).length} 個 tag 已載入\n`)

  // 取得 festival_awards 電影列表，找出 0 tags 的
  const { data: awards } = await directusApi(token, 'GET', '/items/festival_awards?limit=-1&fields=movie')
  const awardMovieIds = [...new Set(awards.map(a => a.movie))]

  const { data: movies } = await directusApi(token, 'GET',
    `/items/movies?limit=-1&fields=id,title,original_title,year,tags.id&filter[id][_in]=${awardMovieIds.join(',')}`)

  const noTagMovies = movies.filter(m => !m.tags?.length)
  console.log(`🎬 影展電影共 ${awardMovieIds.length} 部，其中 ${noTagMovies.length} 部缺少 tags\n`)

  // 讀取 festival-awards.json，建立 title+year → original_title 的對照
  const { awards: festivalData } = JSON.parse(
    readFileSync(join(__dirname, '..', 'data', 'festival-awards.json'), 'utf-8')
  )
  const origTitleMap = {}
  for (const entry of festivalData) {
    const key = `${entry.movie_title}__${entry.movie_year}`
    if (entry.movie_original_title) origTitleMap[key] = entry.movie_original_title
  }

  let enriched = 0, fallback = 0, notFound = 0, errors = 0

  for (const movie of noTagMovies) {
    const key = `${movie.title}__${movie.year}`
    const originalTitle = origTitleMap[key] || movie.original_title || movie.title

    process.stdout.write(`《${movie.title}》(${movie.year}) [${originalTitle}] ... `)

    // 搜 TMDB
    await new Promise(r => setTimeout(r, 300))
    const tmdbMovie = await searchTMDB(originalTitle, movie.year)

    let tagWeights = {}
    let posterUrl = null

    if (tmdbMovie && tmdbMovie.genre_ids?.length) {
      tagWeights = buildTagWeights(tmdbMovie.genre_ids)
      posterUrl = tmdbMovie.poster_path
        ? `https://image.tmdb.org/t/p/w500${tmdbMovie.poster_path}`
        : null
    }

    // 若 TMDB 沒有或 genre 對應不到任何 tag，用 fallback
    if (Object.keys(tagWeights).length === 0) {
      // 根據 award_category 或 festival 推斷
      const { data: movieAwards } = await directusApi(token, 'GET',
        `/items/festival_awards?filter[movie][_eq]=${movie.id}&fields=festival,award_category&limit=1`)
      const award = movieAwards?.[0]
      if (award?.award_category?.includes('紀錄片') || award?.festival === 'TIDF') {
        FESTIVAL_FALLBACK_TAGS['紀錄片'].forEach((t, i) => {
          tagWeights[t] = i === 0 ? 1.5 : 1.0
        })
      } else {
        FESTIVAL_FALLBACK_TAGS['default'].forEach(t => { tagWeights[t] = 1.5 })
        tagWeights['劇情'] = 1.0
      }
      fallback++
      process.stdout.write('[fallback] ')
    } else {
      enriched++
    }

    // 過濾出 Directus 裡存在的 tag
    const tagEntries = Object.entries(tagWeights)
      .filter(([name]) => tagMap[name])
      .map(([name, weight]) => ({ tags_id: tagMap[name], weight }))

    if (tagEntries.length === 0) {
      console.log('⚠ 無可用 tag，跳過')
      notFound++
      continue
    }

    if (DRY_RUN) {
      console.log('→', Object.entries(tagWeights).map(([t, w]) => `${t}(${w})`).join(', '))
      continue
    }

    const payload = {
      tags: tagEntries,
      ...(posterUrl ? { poster_url: posterUrl } : {}),
    }

    const res = await directusApi(token, 'PATCH', `/items/movies/${movie.id}`, payload)
    if (res.errors) {
      console.log('✗', res.errors[0]?.message)
      errors++
    } else {
      console.log('✓', Object.keys(tagWeights).join(', '))
    }
  }

  console.log('\n──────────────────────────────')
  console.log('✅ 完成')
  console.log(`   TMDB 補齊：${enriched} 部`)
  console.log(`   Fallback 標記：${fallback} 部`)
  if (notFound) console.log(`   無法處理：${notFound} 部`)
  if (errors)   console.log(`   ⚠ 錯誤：${errors} 部`)
}

main().catch(err => { console.error('執行失敗:', err); process.exit(1) })
