// fix-oscar-placeholder.mjs
// 重建「奧斯卡 / 得獎影片」placeholder 紀錄。資料來源：TMDB → IMDb id → Wikidata SPARQL。
//
// 用法：
//   node midnight-be/scripts/fix-oscar-placeholder.mjs            # dry-run，輸出 report
//   node midnight-be/scripts/fix-oscar-placeholder.mjs --apply    # 實際寫入 Directus
//
// 流程（每筆 placeholder）：
//   1. movie 已被刪除（dangling） → 刪 placeholder
//   2. TMDB search(原文片名, 年份) → IMDb id
//        失敗 → 列入 todo 清單，保留 placeholder
//   3. Wikidata SPARQL → 該片所有奧斯卡得獎 / 入圍（含 ceremony 年份）
//        無紀錄 → 該片其實沒上過奧斯卡 → 刪 placeholder
//        有紀錄 → 刪 placeholder + 插入具體獎項
//
// 輸出：fix-oscar-report.json

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf-8')
    .split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const APPLY = process.argv.includes('--apply')
const BASE = 'http://localhost:8055'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_KEY = env.TMDB_API_KEY
const SPARQL = 'https://query.wikidata.org/sparql'

if (!TMDB_KEY) { console.error('❌ 缺少 TMDB_API_KEY'); process.exit(1) }

// ── 中文獎項標準化 ───────────────────────────
// Wikidata 標籤格式：「奧斯卡最佳XXX獎」/「奧斯卡最佳XXX」
// 既存資料格式：去掉「奧斯卡」前綴 + 去掉「獎」後綴 + 別名統整
const CATEGORY_ALIAS = {
  '最佳影片': '最佳影片',
  '最佳導演': '最佳導演',
  '最佳男主角': '最佳男主角',
  '最佳女主角': '最佳女主角',
  '最佳男配角': '最佳男配角',
  '最佳女配角': '最佳女配角',
  '最佳原著劇本': '最佳原著劇本',
  '最佳原創劇本': '最佳原著劇本',
  '最佳改編劇本': '最佳改編劇本',
  '最佳剪輯': '最佳剪輯',
  '最佳影片剪輯': '最佳剪輯',
  '最佳攝影': '最佳攝影',
  '最佳美術設計': '最佳美術設計',
  '最佳藝術指導': '最佳美術設計',
  '最佳服裝設計': '最佳服裝設計',
  '最佳化妝與髮型設計': '最佳化妝與髮型設計',
  '最佳化妝': '最佳化妝與髮型設計',
  '最佳視覺效果': '最佳視覺效果',
  '最佳音效': '最佳音效',
  '最佳音效剪輯': '最佳音效',
  '最佳音響效果': '最佳音效',
  '最佳音效混音': '最佳音效混音',
  '最佳混音': '最佳音效混音',
  '最佳原創音樂': '最佳原著配樂',
  '最佳原著配樂': '最佳原著配樂',
  '最佳配樂': '最佳原著配樂',
  '最佳原創歌曲': '最佳原創歌曲',
  '最佳歌曲': '最佳原創歌曲',
  '最佳動畫': '最佳動畫',
  '最佳動畫長片': '最佳動畫',
  '最佳動畫片': '最佳動畫',
  '最佳紀錄片': '最佳紀錄片',
  '最佳紀錄長片': '最佳紀錄片',
  '最佳紀錄短片': '最佳紀錄短片',
  '最佳國際影片': '最佳國際影片',
  '最佳外語片': '最佳國際影片',
  '最佳真人短片': '最佳真人短片',
  '最佳動畫短片': '最佳動畫短片',
  // 鐵達尼號之類的子類別
  '最佳原創戲劇配樂': '最佳原著配樂',
  '最佳原創音樂劇配樂': '最佳原著配樂',
  '最佳原創喜劇配樂': '最佳原著配樂',
  '最佳戲劇類原創配樂': '最佳原著配樂',
  '最佳音樂劇或喜劇類原創配樂': '最佳原著配樂',
  '最佳音響效果剪輯': '最佳音效',
  '最佳音響效果': '最佳音效',
}

// 英文 fallback（沒中文 label 時用）
const EN_ALIAS = {
  'Academy Award for Best Picture': '最佳影片',
  'Academy Award for Best Director': '最佳導演',
  'Academy Award for Best Actor': '最佳男主角',
  'Academy Award for Best Actress': '最佳女主角',
  'Academy Award for Best Supporting Actor': '最佳男配角',
  'Academy Award for Best Supporting Actress': '最佳女配角',
  'Academy Award for Best Writing, Original Screenplay': '最佳原著劇本',
  'Academy Award for Best Original Screenplay': '最佳原著劇本',
  'Academy Award for Best Writing, Adapted Screenplay': '最佳改編劇本',
  'Academy Award for Best Adapted Screenplay': '最佳改編劇本',
  'Academy Award for Best Film Editing': '最佳剪輯',
  'Academy Award for Best Cinematography': '最佳攝影',
  'Academy Award for Best Production Design': '最佳美術設計',
  'Academy Award for Best Art Direction': '最佳美術設計',
  'Academy Award for Best Costume Design': '最佳服裝設計',
  'Academy Award for Best Makeup and Hairstyling': '最佳化妝與髮型設計',
  'Academy Award for Best Makeup': '最佳化妝與髮型設計',
  'Academy Award for Best Visual Effects': '最佳視覺效果',
  'Academy Award for Best Sound': '最佳音效',
  'Academy Award for Best Sound Editing': '最佳音效',
  'Academy Award for Best Sound Mixing': '最佳音效混音',
  'Academy Award for Best Original Score': '最佳原著配樂',
  'Academy Award for Best Original Music Score': '最佳原著配樂',
  'Academy Award for Best Original Dramatic Score': '最佳原著配樂',
  'Academy Award for Best Original Musical or Comedy Score': '最佳原著配樂',
  'Academy Award for Best Music (Original Musical or Comedy Score)': '最佳原著配樂',
  'Academy Award for Best Music (Original Dramatic Score)': '最佳原著配樂',
  'Academy Award for Best Original Song': '最佳原創歌曲',
  'Academy Award for Best Animated Feature': '最佳動畫',
  'Academy Award for Best Animated Feature Film': '最佳動畫',
  'Academy Award for Best Documentary Feature': '最佳紀錄片',
  'Academy Award for Best Documentary Short Subject': '最佳紀錄短片',
  'Academy Award for Best International Feature Film': '最佳國際影片',
  'Academy Award for Best Foreign Language Film': '最佳國際影片',
  'Academy Award for Best Live Action Short Film': '最佳真人短片',
  'Academy Award for Best Animated Short Film': '最佳動畫短片',
}

// 簡體 → 繁體（只列腳本實際遇到的字）
const S2T = {
  '奖':'獎','剧':'劇','导':'導','艺':'藝','术':'術','装':'裝','发':'髮','视':'視',
  '觉':'覺','声':'聲','乐':'樂','动':'動','画':'畫','长':'長','纪':'紀','录':'錄',
  '编':'編','创':'創','执':'執','优':'優','场':'場','摄':'攝','谱':'譜','剪':'剪',
  '辑':'輯','色':'色','音':'音','响':'響','别':'別','内':'內','体':'體','应':'應',
  '类':'類','为':'為','与':'與','献':'獻','欢':'歡','颂':'頌','显':'顯','贡':'貢',
  '结':'結','复':'復','几':'幾','题':'題','级':'級','马':'馬','黄':'黃','众':'眾',
  '着':'著','参':'參','尔':'爾','卑':'卑','劳':'勞','妆':'妝','奥':'奧','设':'設',
  '计':'計','原':'原','歌':'歌','曲':'曲','片':'片','配':'配','女':'女','男':'男',
}
function s2t(s) { return s.split('').map(c => S2T[c] ?? c).join('') }

function normalizeCategory(label) {
  if (!label) return label
  // 1. 繁體化
  let s = s2t(label)
  // 2. 去 prefix/suffix
  s = s.replace(/^奧斯卡/, '').replace(/獎$/, '').trim()
  // 3. 別名統整
  return CATEGORY_ALIAS[s] ?? s
}

// ── Directus ──────────────────────────────
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
  if (res.status === 204) return {}
  return res.json()
}

async function fetchPlaceholders(token) {
  const q = '/items/festival_awards'
    + '?filter[festival][_eq]=' + encodeURIComponent('奧斯卡')
    + '&filter[award_category][_eq]=' + encodeURIComponent('得獎影片')
    + '&fields=id,year,result,movie.id,movie.title,movie.original_title,movie.year'
    + '&limit=-1'
  const res = await api(token, 'GET', q)
  return res.data ?? []
}

async function existingAwardsForMovie(token, movieId) {
  const q = `/items/festival_awards?filter[movie][_eq]=${movieId}&fields=festival,year,award_category,result&limit=-1`
  const res = await api(token, 'GET', q)
  return res.data ?? []
}

// ── TMDB ──────────────────────────────────
async function tmdbSearchImdbId(originalTitle, year) {
  if (!originalTitle) return null
  const q = encodeURIComponent(originalTitle)
  const url = `${TMDB_BASE}/search/movie?query=${q}&year=${year}&api_key=${TMDB_KEY}`
  let res = await fetch(url)
  if (!res.ok) return null
  let data = await res.json()
  let hit = data?.results?.[0]
  if (!hit) {
    // 退一步試 year ± 1（例如資料記錄頒獎年 vs 上映年差一年）
    for (const y of [year - 1, year + 1]) {
      res = await fetch(`${TMDB_BASE}/search/movie?query=${q}&year=${y}&api_key=${TMDB_KEY}`)
      if (!res.ok) continue
      data = await res.json()
      hit = data?.results?.[0]
      if (hit) break
    }
  }
  if (!hit) return null
  // 取 imdb_id
  const ext = await fetch(`${TMDB_BASE}/movie/${hit.id}/external_ids?api_key=${TMDB_KEY}`)
  if (!ext.ok) return null
  const j = await ext.json()
  return j.imdb_id || null
}

// ── Wikidata ──────────────────────────────
async function wikidataAcademyAwards(imdbId) {
  const query = `
    SELECT ?awardZhTw ?awardZhHant ?awardZh ?awardEn ?result ?ceremony WHERE {
      ?film wdt:P345 "${imdbId}".
      { ?film p:P166 ?stmt. ?stmt ps:P166 ?award. BIND("won" AS ?result) }
      UNION
      { ?film p:P1411 ?stmt. ?stmt ps:P1411 ?award. BIND("nominated" AS ?result) }
      ?award wdt:P31 wd:Q19020.
      OPTIONAL { ?stmt pq:P585 ?ceremony. }
      ?award rdfs:label ?awardEn. FILTER(LANG(?awardEn) = "en")
      OPTIONAL { ?award rdfs:label ?awardZhTw. FILTER(LANG(?awardZhTw) = "zh-tw") }
      OPTIONAL { ?award rdfs:label ?awardZhHant. FILTER(LANG(?awardZhHant) = "zh-hant") }
      OPTIONAL { ?award rdfs:label ?awardZh. FILTER(LANG(?awardZh) = "zh") }
    }
  `
  const res = await fetch(`${SPARQL}?query=${encodeURIComponent(query)}`, {
    headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': 'midnight-moodvie-fix-oscar/1.0' },
  })
  if (!res.ok) {
    console.log(`  ⚠ Wikidata HTTP ${res.status}`)
    return []
  }
  const j = await res.json()
  const rows = j.results?.bindings ?? []

  // 同 award 多筆 → 取 zh-tw > zh-hant > zh > en
  const dedup = new Map()
  for (const r of rows) {
    const en = r.awardEn?.value ?? ''
    const result = r.result?.value
    const zh = r.awardZhTw?.value || r.awardZhHant?.value || r.awardZh?.value || ''
    const ceremony = r.ceremony?.value ?? ''
    const key = `${en}|${result}`
    const cur = dedup.get(key)
    if (!cur) {
      dedup.set(key, { en, zh, result, ceremony })
    } else {
      // 同 key 多列：保留更具優先級的 zh（這個 query 已經把優先級平攤了，所以拿到非空的就保留）
      if (!cur.zh && zh) cur.zh = zh
      if (!cur.ceremony && ceremony) cur.ceremony = ceremony
    }
  }

  // won 蓋掉同名 nominated（一般 Wikidata 會兩筆都建）
  const out = []
  const wonCats = new Set()
  for (const v of dedup.values()) {
    if (v.result === 'won') wonCats.add(v.en)
  }
  for (const v of dedup.values()) {
    if (v.result === 'nominated' && wonCats.has(v.en)) continue
    out.push(v)
  }
  return out
}

// ── 主流程 ─────────────────────────────────
async function main() {
  console.log(APPLY ? '🔥 APPLY 模式（會寫入 Directus）' : '🔍 DRY-RUN 模式（不寫入）')
  console.log()

  const token = await login()
  console.log('✓ 登入成功')

  const placeholders = await fetchPlaceholders(token)
  console.log(`✓ 撈到 ${placeholders.length} 筆 placeholder\n`)

  const report = {
    summary: { total: placeholders.length, dangling: 0, no_oscars: 0, replaced: 0, todo: 0 },
    dangling: [],         // movie 不存在 → 刪
    no_oscars: [],        // Wikidata 查無奧斯卡紀錄 → 刪
    replaced: [],         // 有具體獎項 → 刪 placeholder + 插入具體獎項
    todo: [],             // TMDB / Wikidata 失敗 → 保留 placeholder，人工處理
  }

  let i = 0
  for (const ph of placeholders) {
    i++
    const movie = ph.movie
    const tag = `[${i}/${placeholders.length}]`

    if (!movie) {
      console.log(`${tag} dangling (movie=null) → 刪`)
      report.dangling.push({ placeholder_id: ph.id, year: ph.year })
      report.summary.dangling++
      continue
    }

    process.stdout.write(`${tag} 《${movie.title}》(${movie.original_title || '-'}, ${movie.year}) ... `)

    const imdbId = await tmdbSearchImdbId(movie.original_title || movie.title, movie.year)
    if (!imdbId) {
      console.log('⚠ 找不到 IMDb id → todo')
      report.todo.push({
        placeholder_id: ph.id,
        movie: { id: movie.id, title: movie.title, original_title: movie.original_title, year: movie.year },
        reason: 'TMDB no match',
      })
      report.summary.todo++
      await new Promise(r => setTimeout(r, 250))
      continue
    }

    await new Promise(r => setTimeout(r, 200))
    const awards = await wikidataAcademyAwards(imdbId)

    if (awards.length === 0) {
      console.log(`(${imdbId}) 無奧斯卡紀錄 → 刪 placeholder`)
      report.no_oscars.push({
        placeholder_id: ph.id,
        movie: { id: movie.id, title: movie.title, year: movie.year },
        imdb_id: imdbId,
      })
      report.summary.no_oscars++
      await new Promise(r => setTimeout(r, 300))
      continue
    }

    const existing = await existingAwardsForMovie(token, movie.id)
    const existingKey = (a) => `${a.festival}|${a.year}|${a.award_category}|${a.result}`
    const existingSet = new Set(existing.map(existingKey))

    const newRows = []
    for (const a of awards) {
      // 中文 label 優先；若沒有，用英文 alias 表
      const cat = a.zh ? normalizeCategory(a.zh) : (EN_ALIAS[a.en] ?? a.en)
      const ceremonyYear = a.ceremony ? new Date(a.ceremony).getUTCFullYear() : ph.year
      const row = { festival: '奧斯卡', year: ceremonyYear, award_category: cat, result: a.result }
      if (!existingSet.has(existingKey(row))) {
        newRows.push(row)
        existingSet.add(existingKey(row))
      }
    }

    console.log(`(${imdbId}) → 新增 ${newRows.length} 筆`)
    report.replaced.push({
      placeholder_id: ph.id,
      movie: { id: movie.id, title: movie.title, year: movie.year },
      imdb_id: imdbId,
      new_rows: newRows,
    })
    report.summary.replaced++

    await new Promise(r => setTimeout(r, 350)) // 對 Wikidata 客氣一點
  }

  // ── 輸出 report ──
  const reportPath = join(__dirname, '..', 'data', 'fix-oscar-report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`\n📝 報告已寫入：${reportPath}`)
  console.log(`   dangling=${report.summary.dangling}  no_oscars=${report.summary.no_oscars}  replaced=${report.summary.replaced}  todo=${report.summary.todo}`)

  if (!APPLY) {
    console.log('\n（dry-run；review report 後加 --apply 實際執行）')
    return
  }

  // ── APPLY ──
  console.log('\n🔥 開始寫入 Directus...')
  let deleted = 0, inserted = 0, errors = 0

  // dangling
  for (const x of report.dangling) {
    const r = await api(token, 'DELETE', `/items/festival_awards/${x.placeholder_id}`)
    if (r.errors) errors++; else deleted++
  }
  // no_oscars
  for (const x of report.no_oscars) {
    const r = await api(token, 'DELETE', `/items/festival_awards/${x.placeholder_id}`)
    if (r.errors) errors++; else deleted++
  }
  // replaced
  for (const x of report.replaced) {
    const r1 = await api(token, 'DELETE', `/items/festival_awards/${x.placeholder_id}`)
    if (r1.errors) { errors++; continue }
    deleted++
    for (const row of x.new_rows) {
      const r2 = await api(token, 'POST', '/items/festival_awards', {
        id: randomUUID(),
        movie: x.movie.id,
        ...row,
        edition: null,
      })
      if (r2.errors) errors++; else inserted++
    }
  }

  console.log(`\n✅ 完成：刪除 ${deleted} 筆、新增 ${inserted} 筆${errors ? `，錯誤 ${errors} 筆` : ''}`)
  console.log(`   todo（保留 placeholder）：${report.summary.todo} 筆，請見 report 內 todo 區塊`)
}

main().catch(err => { console.error('執行失敗:', err); process.exit(1) })
