// import-international-festivals.mjs
// 匯入坎城/柏林/威尼斯 2015–2024 得獎片，建立 movies + festival_awards 記錄
// 執行: node midnight-be/scripts/import-international-festivals.mjs [--dry-run]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

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

function buildTagWeights(genreIds) {
  const tagWeights = {}
  genreIds.forEach((id, index) => {
    const mapping = GENRE_TAG_MAP[id]
    if (!mapping) return
    const w = index === 0 ? 2.0 : 1.0
    tagWeights[mapping.primary] = Math.max(tagWeights[mapping.primary] ?? 0, w)
    for (const sec of mapping.secondary) {
      if (!tagWeights[sec]) tagWeights[sec] = 1.0
    }
  })
  return tagWeights
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

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function tmdbGet(path) {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${TMDB_BASE}${path}${sep}api_key=${TMDB_KEY}&language=zh-TW`)
  if (!res.ok) return null
  return res.json()
}

async function searchTmdb(originalTitle, year) {
  const q = encodeURIComponent(originalTitle)
  const data = await tmdbGet(`/search/movie?query=${q}&year=${year}`)
  return data?.results?.[0] ?? null
}

async function findMovieInDirectus(token, title, originalTitle, year) {
  const fields = 'fields=id,title,original_title,year,poster_url,tags.id'
  const r1 = await api(token, 'GET',
    `/items/movies?filter[title][_eq]=${encodeURIComponent(title)}&filter[year][_eq]=${year}&limit=1&${fields}`)
  if (r1.data?.length) return r1.data[0]
  if (originalTitle && originalTitle !== title) {
    const r2 = await api(token, 'GET',
      `/items/movies?filter[original_title][_eq]=${encodeURIComponent(originalTitle)}&filter[year][_eq]=${year}&limit=1&${fields}`)
    if (r2.data?.length) return r2.data[0]
  }
  return null
}

async function enrichMovieTags(token, movie, originalTitle, year, tagMap) {
  await new Promise(r => setTimeout(r, 300))
  const tmdbHit = await searchTmdb(originalTitle, year)

  const tagWeights = tmdbHit?.genre_ids?.length
    ? buildTagWeights(tmdbHit.genre_ids)
    : { '劇情': 2.0, '文藝': 1.0 }

  const tagEntries = Object.entries(tagWeights)
    .filter(([name]) => tagMap[name])
    .map(([name, weight]) => ({ tags_id: tagMap[name], weight }))

  if (tagEntries.length === 0) return false

  const posterUrl = (!movie.poster_url && tmdbHit?.poster_path)
    ? `https://image.tmdb.org/t/p/w500${tmdbHit.poster_path}`
    : null

  const patchRes = await api(token, 'PATCH', `/items/movies/${movie.id}`, {
    tags: tagEntries,
    ...(posterUrl ? { poster_url: posterUrl } : {}),
  })
  return !patchRes.errors
}

async function awardExists(token, movieId, festival, year, awardCategory) {
  const res = await api(token, 'GET',
    `/items/festival_awards?filter[movie][_eq]=${movieId}&filter[festival][_eq]=${encodeURIComponent(festival)}&filter[year][_eq]=${year}&filter[award_category][_eq]=${encodeURIComponent(awardCategory)}&limit=1`)
  return (res.data?.length ?? 0) > 0
}

async function updateFestivalFieldChoices(token) {
  const res = await api(token, 'GET', '/fields/festival_awards/festival')
  const current = res.data?.meta?.options?.choices ?? []
  const existing = new Set(current.map(c => c.value))
  const toAdd = [
    { text: '坎城', value: '坎城' },
    { text: '柏林', value: '柏林' },
    { text: '威尼斯', value: '威尼斯' },
  ].filter(c => !existing.has(c.value))

  if (toAdd.length === 0) {
    console.log('  skip: festival 選項已包含坎城/柏林/威尼斯')
    return
  }

  const updated = [...current, ...toAdd]
  const patchRes = await api(token, 'PATCH', '/fields/festival_awards/festival', {
    meta: { options: { choices: updated } },
  })
  if (patchRes.errors) {
    console.log('  ⚠ 更新 festival 選項失敗:', JSON.stringify(patchRes.errors))
  } else {
    console.log(`  ✓ 已新增選項：${toAdd.map(c => c.text).join(', ')}`)
  }
}

async function main() {
  if (DRY_RUN) console.log('🔍 DRY RUN 模式\n')

  console.log('🔐 登入 Directus...')
  const token = await login()
  console.log('  ✓ 登入成功\n')

  console.log('🔧 更新 festival 欄位選項...')
  await updateFestivalFieldChoices(token)
  console.log()

  // 取得現有 tags
  const { data: existingTags } = await api(token, 'GET', '/items/tags?limit=-1')
  const tagMap = Object.fromEntries((existingTags ?? []).map(t => [t.name, t.id]))
  console.log(`📌 ${Object.keys(tagMap).length} 個 tag 已載入\n`)

  const { awards } = JSON.parse(
    readFileSync(join(__dirname, '..', 'data', 'international-festival-awards.json'), 'utf-8')
  )
  console.log(`🎬 共 ${awards.length} 筆獎項資料\n`)

  let created = 0, skipped = 0, newMovies = 0, errors = 0

  for (const entry of awards) {
    const { movie_title, movie_original_title, movie_year, festival, edition, year, award_category, result } = entry

    process.stdout.write(`《${movie_title}》${festival} ${year} ${award_category} ... `)

    // 找或建立電影
    let movie = await findMovieInDirectus(token, movie_title, movie_original_title, movie_year)

    if (!movie) {
      // 查 TMDB 取得 poster + genre
      await new Promise(r => setTimeout(r, 300))
      const tmdbHit = await searchTmdb(movie_original_title, movie_year)

      const tagWeights = tmdbHit?.genre_ids?.length
        ? buildTagWeights(tmdbHit.genre_ids)
        : { '劇情': 2.0, '文藝': 1.0 }

      const tagEntries = Object.entries(tagWeights)
        .filter(([name]) => tagMap[name])
        .map(([name, weight]) => ({ tags_id: tagMap[name], weight }))

      const posterUrl = tmdbHit?.poster_path
        ? `https://image.tmdb.org/t/p/w500${tmdbHit.poster_path}`
        : null

      if (!DRY_RUN) {
        const createRes = await api(token, 'POST', '/items/movies', {
          id: randomUUID(),
          title: movie_title,
          original_title: movie_original_title || '',
          year: movie_year,
          ...(posterUrl ? { poster_url: posterUrl } : {}),
          ...(tagEntries.length ? { tags: tagEntries } : {}),
        })
        if (createRes.errors) {
          console.log(`\n  ✗ 建立電影失敗：${JSON.stringify(createRes.errors)}`)
          errors++
          continue
        }
        movie = createRes.data
        newMovies++
        process.stdout.write(`[新建+tags] `)
      } else {
        process.stdout.write(`[新建(dry)] `)
        movie = { id: 'DRY_RUN' }
        newMovies++
      }
    } else if (!movie.tags?.length) {
      // 電影已存在但無 tags → 補齊
      if (!DRY_RUN) {
        const ok = await enrichMovieTags(token, movie, movie_original_title, movie_year, tagMap)
        process.stdout.write(ok ? `[補tags] ` : `[補tags失敗] `)
      } else {
        process.stdout.write(`[需補tags(dry)] `)
      }
    }

    // 建立 festival_awards 記錄
    if (!DRY_RUN && movie.id !== 'DRY_RUN') {
      if (await awardExists(token, movie.id, festival, year, award_category)) {
        console.log('skip')
        skipped++
        continue
      }
      const awardRes = await api(token, 'POST', '/items/festival_awards', {
        id: randomUUID(),
        movie: movie.id,
        festival,
        year,
        edition: edition ?? null,
        award_category,
        result,
      })
      if (awardRes.errors) {
        console.log(`✗ ${JSON.stringify(awardRes.errors)}`)
        errors++
      } else {
        console.log('✓')
        created++
      }
    } else {
      console.log('✓(dry)')
      created++
    }

    await new Promise(r => setTimeout(r, 150))
  }

  console.log('\n──────────────────────────────')
  console.log('✅ 完成')
  console.log(`   新增影展記錄：${created} 筆`)
  console.log(`   略過（已存在）：${skipped} 筆`)
  console.log(`   新建電影：${newMovies} 部`)
  if (errors) console.log(`   ⚠ 錯誤：${errors} 筆`)
}

main().catch(err => { console.error('執行失敗:', err); process.exit(1) })
