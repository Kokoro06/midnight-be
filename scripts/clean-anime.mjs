// clean-anime.mjs — 刪除日本 2D 動畫（Animation + 日語），保留吉卜力 / 宮崎駿
// 執行: node midnight-be/scripts/clean-anime.mjs [--dry-run]
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

const ANIMATION_GENRE = 16
const GHIBLI_COMPANY_ID = 10342

// 吉卜力 / 宮崎駿 / 高畑勳 導演名
const GHIBLI_DIRECTORS = new Set([
  'Hayao Miyazaki', 'Isao Takahata', 'Yoshifumi Kondō', 'Hiroyuki Morita',
  'Gorō Miyazaki', 'Hiromasa Yonebayashi', 'Michaël Dudok de Wit',
])

// 已知吉卜力原文片名白名單（保底）
const GHIBLI_ORIGINALS = new Set([
  '風の谷のナウシカ', '天空の城ラピュタ', 'となりのトトロ', '火垂るの墓',
  '魔女の宅急便', 'おもひでぽろぽろ', '紅の豚', '海がきこえる',
  '平成狸合戦ぽんぽこ', '耳をすませば', 'もののけ姫', '隣のヤマダくん',
  '千と千尋の神隠し', '猫の恩返し', 'ハウルの動く城', 'ゲド戦記',
  '崖の上のポニョ', '借りぐらしのアリエッティ', 'コクリコ坂から',
  '風立ちぬ', 'かぐや姫の物語', '思い出のマーニー', '赤毛のアン',
  '君たちはどう生きるか',
])

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
  const data = await tmdbGet(`/search/movie?query=${q}&year=${year}&language=zh-TW`)
  return data?.results?.[0] ?? null
}

async function isGhibli(tmdbId) {
  const details = await tmdbGet(`/movie/${tmdbId}?append_to_response=credits`)
  if (!details) return false
  if ((details.production_companies ?? []).some(c => c.id === GHIBLI_COMPANY_ID)) return true
  const directors = (details.credits?.crew ?? []).filter(c => c.job === 'Director')
  return directors.some(d => GHIBLI_DIRECTORS.has(d.name))
}

async function main() {
  if (DRY_RUN) console.log('🔍 DRY RUN 模式 — 不會真正刪除\n')

  console.log('🔐 登入 Directus...')
  const token = await login()
  console.log('  ✓ 登入成功\n')

  const { data: movies } = await directusApi(token, 'GET',
    '/items/movies?limit=-1&fields=id,title,original_title,year')
  console.log(`📦 共 ${movies.length} 部電影待檢查\n`)

  const toDelete = []
  const kept = []

  for (const movie of movies) {
    const searchTitle = movie.original_title || movie.title
    await new Promise(r => setTimeout(r, 250))

    const hit = await searchTmdb(searchTitle, movie.year)
    if (!hit) continue

    const isAnim = hit.genre_ids?.includes(ANIMATION_GENRE)
    const isJapanese = hit.original_language === 'ja'

    if (!isAnim || !isJapanese) continue

    // 白名單原文片名先過一遍
    if (GHIBLI_ORIGINALS.has(hit.original_title)) {
      kept.push(movie.title)
      process.stdout.write(`  🌿 保留（白名單）：《${movie.title}》\n`)
      continue
    }

    // 再查 TMDB 詳細資料確認吉卜力
    await new Promise(r => setTimeout(r, 250))
    if (await isGhibli(hit.id)) {
      kept.push(movie.title)
      process.stdout.write(`  🌿 保留（吉卜力）：《${movie.title}》\n`)
      continue
    }

    toDelete.push({ ...movie, tmdbTitle: hit.title })
    process.stdout.write(`  ❌ 標記刪除：《${movie.title}》（${movie.year}）[TMDB: ${hit.original_title}]\n`)
  }

  console.log(`\n──────────────────────────────`)
  console.log(`🎌 保留：${kept.length} 部（吉卜力/宮崎駿）`)
  console.log(`🗑  待刪：${toDelete.length} 部`)

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
