// seed.mjs — 批次匯入 tags 與 movies 至 Directus
// 執行: node midnight-be/scripts/seed.mjs
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf-8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const BASE = process.env.DIRECTUS_URL || 'http://localhost:8055'
const POSTERS_DIR = join(__dirname, '../../midnight-fe/public/img')

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  })
  const { data } = await res.json()
  return data.access_token
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// ── 資料定義 ─────────────────────────────────────────────

const TAGS = [
  // 情緒
  { name: '愛情', category: '情緒' },
  { name: '浪漫', category: '情緒' },
  { name: '寂寞', category: '情緒' },
  { name: '憂鬱', category: '情緒' },
  { name: '療癒', category: '情緒' },
  { name: '溫馨', category: '情緒' },
  { name: '放鬆', category: '情緒' },
  { name: '平靜', category: '情緒' },
  // 類型
  { name: '犯罪', category: '類型' },
  { name: '劇情', category: '類型' },
  { name: '科幻', category: '類型' },
  { name: '懸疑', category: '類型' },
  { name: '驚悚', category: '類型' },
  { name: '動作', category: '類型' },
  { name: '奇幻', category: '類型' },
  { name: '喜劇', category: '類型' },
  { name: '戰爭', category: '類型' },
  { name: '紀錄片', category: '類型' },
  { name: 'LGBTQ', category: '類型' },
  { name: '公路電影', category: '類型' },
  // 風格
  { name: '文藝', category: '風格' },
  { name: '燒腦', category: '風格' },
  { name: '經典', category: '風格' },
  { name: '末日', category: '風格' },
  { name: '社會', category: '風格' },
  { name: '青春', category: '風格' },
  { name: '諷刺', category: '風格' },
  { name: '政治', category: '風格' },
  { name: '冒險', category: '風格' },
  { name: '邪典', category: '風格' },
]

const MOVIES = [
  { title: '《重慶森林》', original_title: 'Chungking Express', year: 1994, img: 'poster_chungking.jpg', tags: ['愛情', '寂寞', '文藝', '放鬆'] },
  { title: '《之前的我們》', original_title: 'Past Lives', year: 2023, img: 'poster_pastlives.jpg', tags: ['愛情', '浪漫', '文藝', '青春'] },
  { title: '《日麗》', original_title: 'Aftersun', year: 2022, img: 'poster_aftersun.jpg', tags: ['憂鬱', '療癒', '溫馨', '文藝'] },
  { title: '《教父》', original_title: 'The Godfather', year: 1972, img: 'poster_godfather.jpg', tags: ['犯罪', '劇情', '經典', '動作'] },
  { title: '《星際效應》', original_title: 'Interstellar', year: 2014, img: 'poster_interstellar.jpg', tags: ['科幻', '寂寞', '燒腦', '末日'] },
  { title: '《沙丘》', original_title: 'Dune', year: 2021, img: 'poster_dune.jpg', tags: ['科幻', '奇幻', '動作', '政治'] },
  { title: '《寄生上流》', original_title: 'Parasite', year: 2019, img: 'poster_parasite.jpg', tags: ['懸疑', '驚悚', '諷刺', '犯罪'] },
  { title: '《王牌冤家》', original_title: 'Eternal Sunshine of the Spotless Mind', year: 2004, img: 'poster_eternal.jpg', tags: ['愛情', '奇幻', '憂鬱', '浪漫'] },
  { title: '《瘋狂麥斯：憤怒道》', original_title: 'Mad Max: Fury Road', year: 2015, img: 'poster_madmax.jpg', tags: ['動作', '末日', '科幻', '邪典'] },
  { title: '《花樣年華》', original_title: 'In the Mood for Love', year: 2000, img: 'poster_inthemood.jpg', tags: ['浪漫', '寂寞', '文藝', '經典'] },
  { title: '《小丑》', original_title: 'Joker', year: 2019, img: 'poster_joker.jpg', tags: ['憂鬱', '犯罪', '劇情', '社會'] },
  { title: '《大佛普拉斯》', original_title: 'The Great Buddha+', year: 2017, img: 'poster_buddha.jpg', tags: ['諷刺', '寂寞', '喜劇', '文藝'] },
  { title: '《名偵探柯南》', original_title: 'Detective Conan', year: 2024, img: 'poster_conan.jpg', tags: ['懸疑', '燒腦', '動作'] },
  { title: '《楚門的世界》', original_title: 'The Truman Show', year: 1998, img: 'poster_truman.jpg', tags: ['諷刺', '劇情', '科幻', '平靜'] },
  { title: '《蒼鷺與少年》', original_title: 'The Boy and the Heron', year: 2023, img: 'poster_boyheron.jpg', tags: ['奇幻', '療癒', '冒險', '溫馨'] },
  { title: '《捍衛戰士：獨行俠》', original_title: 'Top Gun: Maverick', year: 2022, img: 'poster_topgun.jpg', tags: ['動作', '青春', '經典'] },
  { title: '《媽的多重宇宙》', original_title: 'Everything Everywhere All at Once', year: 2022, img: 'poster_eeaao.jpg', tags: ['奇幻', '喜劇', '科幻', '溫馨'] },
  { title: '《我愛你，愛你，愛你》', original_title: 'I Love You, I Love You', year: 2021, img: 'poster_lgbt1.jpg', tags: ['LGBTQ', '愛情', '浪漫'] },
  { title: '《燃燒女子的畫像》', original_title: 'Portrait of a Lady on Fire', year: 2019, img: 'poster_portrait.jpg', tags: ['LGBTQ', '文藝', '愛情', '平靜'] },
  { title: '《敦克爾克大行動》', original_title: 'Dunkirk', year: 2017, img: 'poster_dunkirk.jpg', tags: ['戰爭', '動作', '懸疑'] },
  { title: '《辛德勒的名單》', original_title: "Schindler's List", year: 1993, img: 'poster_schindler.jpg', tags: ['戰爭', '經典', '憂鬱'] },
  { title: '《公路之王》', original_title: 'Kings of the Road', year: 1976, img: 'poster_kingsroad.jpg', tags: ['公路電影', '文藝', '寂寞'] },
  { title: '《德州巴黎》', original_title: 'Paris, Texas', year: 1984, img: 'poster_paris.jpg', tags: ['公路電影', '文藝', '憂鬱', '經典'] },
  { title: '《關於我和鬼變成家人的那件事》', original_title: 'Marry My Dead Body', year: 2023, img: 'poster_marrymydeadbody.jpg', tags: ['喜劇', '動作', 'LGBTQ', '溫馨'] },
  { title: '《消失的妳》', original_title: '', year: 2023, img: 'poster_docu1.jpg', tags: ['紀錄片', '平靜', '療癒'] },
  { title: '《藍色茉莉》', original_title: 'Blue Jasmine', year: 2013, img: 'poster_jasmine.jpg', tags: ['諷刺', '劇情', '憂鬱'] },
  { title: '《銀翼殺手2049》', original_title: 'Blade Runner 2049', year: 2017, img: 'poster_br2049.jpg', tags: ['科幻', '寂寞', '文藝', '燒腦'] },
  { title: '《沉默的羔羊》', original_title: 'The Silence of the Lambs', year: 1991, img: 'poster_silence.jpg', tags: ['驚悚', '犯罪', '燒腦', '經典'] },
  { title: '《橫道世之介》', original_title: 'Yokomichi Yonosuke', year: 2013, img: 'poster_yosonosuke.jpg', tags: ['青春', '療癒', '溫馨', '喜劇'] },
]

// ── 主流程 ───────────────────────────────────────────────

async function uploadPoster(token, imgFile) {
  const imgPath = join(POSTERS_DIR, imgFile)
  if (!existsSync(imgPath)) return null

  const bytes = readFileSync(imgPath)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), imgFile)
  const res = await fetch(`${BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const { data } = await res.json()
  return data?.id ?? null
}

async function main() {
  console.log('🔐 登入 Directus...')
  const token = await login()

  // 1. 建立 tags
  console.log('\n📌 建立 tags...')
  const existingTags = (await api(token, 'GET', '/items/tags?limit=-1')).data ?? []
  const tagMap = Object.fromEntries(existingTags.map(t => [t.name, t.id]))

  for (const tag of TAGS) {
    if (tagMap[tag.name]) {
      console.log(`  skip: ${tag.name} (已存在)`)
      continue
    }
    const { data } = await api(token, 'POST', '/items/tags', tag)
    tagMap[tag.name] = data.id
    console.log(`  ✓ ${tag.name} [${tag.category}]`)
  }

  // 2. 建立 movies + M2M
  console.log('\n🎬 建立 movies...')
  const existingMovies = (await api(token, 'GET', '/items/movies?limit=-1&fields=title')).data ?? []
  const existingTitles = new Set(existingMovies.map(m => m.title))

  for (const movie of MOVIES) {
    if (existingTitles.has(movie.title)) {
      console.log(`  skip: ${movie.title} (已存在)`)
      continue
    }

    // 上傳海報（若檔案存在）
    let posterId = null
    if (movie.img) {
      posterId = await uploadPoster(token, movie.img)
      if (posterId) console.log(`  📸 上傳海報: ${movie.img}`)
    }

    // 建立 movie
    const tagIds = movie.tags
      .filter(name => tagMap[name])
      .map(name => ({ tags_id: { id: tagMap[name] } }))

    const { data, errors } = await api(token, 'POST', '/items/movies', {
      title: movie.title,
      original_title: movie.original_title,
      year: movie.year,
      poster: posterId,
      tags: tagIds,
    })

    if (errors) {
      console.error(`  ✗ ${movie.title}:`, errors)
    } else {
      console.log(`  ✓ ${movie.title} (${movie.year}) tags: ${movie.tags.join(', ')}`)
    }
  }

  console.log('\n✅ 完成！')
  console.log(`驗證: curl "http://localhost:8055/items/movies?fields=*,tags.tags_id.*&limit=2"`)
}

main().catch(console.error)
