// seed-festivals.mjs — 匯入 festival_awards 資料至 Directus
// 執行: node midnight-be/scripts/seed-festivals.mjs
//
// 邏輯：
//   1. 讀取 data/festival-awards.json
//   2. 每筆資料用片名 + 上映年份比對現有 movies collection
//   3. 找到 → 直接建立 festival_awards 記錄
//   4. 找不到 → 先建立電影（無海報），再建立 festival_awards 記錄
//   5. festival_awards 已存在（同 movie + festival + year + award_category）→ skip

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf-8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const BASE = 'http://localhost:8055'

const { awards } = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'festival-awards.json'), 'utf-8')
)

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  })
  const body = await res.json()
  if (!body.data?.access_token) {
    console.error('登入失敗:', JSON.stringify(body))
    process.exit(1)
  }
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

async function findMovie(token, title, year) {
  const encoded = encodeURIComponent(title)
  const res = await api(
    token, 'GET',
    `/items/movies?filter[title][_eq]=${encoded}&filter[year][_eq]=${year}&limit=1`
  )
  return res.data?.[0] ?? null
}

async function createMovie(token, title, originalTitle, year) {
  const res = await api(token, 'POST', '/items/movies', {
    id: randomUUID(),
    title,
    original_title: originalTitle || '',
    year,
  })
  if (res.errors) {
    console.error(`  ✗ 建立電影失敗《${title}》:`, JSON.stringify(res.errors))
    return null
  }
  return res.data
}

async function awardExists(token, movieId, festival, year, awardCategory) {
  const res = await api(
    token, 'GET',
    `/items/festival_awards?filter[movie][_eq]=${movieId}&filter[festival][_eq]=${encodeURIComponent(festival)}&filter[year][_eq]=${year}&filter[award_category][_eq]=${encodeURIComponent(awardCategory)}&limit=1`
  )
  return (res.data?.length ?? 0) > 0
}

async function createAward(token, movieId, entry) {
  const res = await api(token, 'POST', '/items/festival_awards', {
    id: randomUUID(),
    movie: movieId,
    festival: entry.festival,
    year: entry.year,
    edition: entry.edition ?? null,
    award_category: entry.award_category,
    result: entry.result,
  })
  if (res.errors) {
    console.error(`  ✗ 建立影展記錄失敗:`, JSON.stringify(res.errors))
    return false
  }
  return true
}

async function main() {
  console.log('🔐 登入 Directus...')
  const token = await login()
  console.log('  ✓ 登入成功\n')

  let created = 0
  let skipped = 0
  let newMovies = 0
  let errors = 0

  for (const entry of awards) {
    const { movie_title, movie_original_title, movie_year, festival, year, award_category } = entry

    process.stdout.write(`《${movie_title}》${festival} ${year} ${award_category} ... `)

    let movie = await findMovie(token, movie_title, movie_year)

    if (!movie) {
      movie = await createMovie(token, movie_title, movie_original_title, movie_year)
      if (!movie) { errors++; continue }
      console.log(`\n  ＋ 新建電影《${movie_title}》(${movie_year})`)
      newMovies++
    }

    if (await awardExists(token, movie.id, festival, year, award_category)) {
      console.log('skip')
      skipped++
      continue
    }

    const ok = await createAward(token, movie.id, entry)
    if (ok) {
      console.log('✓')
      created++
    } else {
      errors++
    }
  }

  console.log('\n─────────────────────────────')
  console.log(`✅ 完成`)
  console.log(`   新增影展記錄：${created} 筆`)
  console.log(`   略過（已存在）：${skipped} 筆`)
  console.log(`   新建電影：${newMovies} 筆`)
  if (errors > 0) console.log(`   ⚠ 錯誤：${errors} 筆`)
}

main().catch(err => {
  console.error('執行失敗:', err)
  process.exit(1)
})
