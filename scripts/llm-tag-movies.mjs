// llm-tag-movies.mjs — Phase 3 LLM 批次標記情緒/風格 tag
//
// 執行:
//   node midnight-be/scripts/llm-tag-movies.mjs --dry-run --limit=20
//     └─ 抽 20 部試跑、不寫回 Directus、印出 LLM 輸出供檢查
//   node midnight-be/scripts/llm-tag-movies.mjs --limit=20
//     └─ 抽 20 部正式寫回 Directus
//   node midnight-be/scripts/llm-tag-movies.mjs
//     └─ 全集 791 部跑完整批次
//   node midnight-be/scripts/llm-tag-movies.mjs --reset
//     └─ 清掉進度檔，從頭再跑一次
//
// 策略：清掉所有現有的 情緒/風格 tag，由 Claude Haiku 4.5 重新判定。類型 tag 保留。

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
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
const RESET = process.argv.includes('--reset')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '99999')

const BASE = 'http://localhost:8055'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_KEY = env.TMDB_API_KEY
const PROGRESS_FILE = join(__dirname, '..', 'tmp', 'llm-tag-processed.txt')

if (!env.ANTHROPIC_API_KEY) { console.error('❌ 缺少 ANTHROPIC_API_KEY'); process.exit(1) }
if (!TMDB_KEY) { console.error('❌ 缺少 TMDB_API_KEY'); process.exit(1) }

// ── 受控詞彙：Claude 只能從這 21 個 tag 選 ──────────────────
const VALID_TAGS = [
  // 情緒
  '靜靜看就好', '心動的感覺', '暖暖的就好', '有點寂寞', '想談戀愛',
  '躺著看就好', '需要被療癒', '好想哭', '想哭一場', '很有壓迫感', '想愛又怕受傷',
  // 風格
  '想看點怪的', '這世界很荒謬', '政治', '世界毀了也無所謂', '社會',
  '想念那時候', '經典', '冒險', '文藝', '越燒越好',
]

// ── Taxonomy（必須 ≥4096 token 才能啟用 Haiku 4.5 prompt cache）────
const TAXONOMY = `你是電影情緒/風格分類器，幫一個中文電影心情推薦網站標 tag。

你會看到一部電影的：片名、年份、TMDB 劇情簡介、現有的類型 tag。
請判定這部片真正的情緒氛圍與風格調性，從受控詞彙裡選出 0–5 個最貼切的 tag，每個給 weight 1.0 或 2.0。

# 重要原則
- **誠實比硬塞好**：純動作爽片可以一個 mood/style tag 都不選（觀眾要的是 類型 tag 已經夠了）
- **核心氛圍給 2.0，次要氛圍給 1.0**：weight 2.0 代表「這部片就是這個情緒」，1.0 代表「附帶有這個感覺」
- **不要過度標**：不貼切就不選；超過 5 個一定有錯
- **看過的觀眾會怎麼形容這部片**，不是「劇情有什麼元素」就標什麼

# 情緒 tags（描述觀眾想要的觀影心情）

## 靜靜看就好
適合放著當背景、節奏緩、低耗能、不費神的片。
✓《Paterson》《一一》《小森食光》《My Neighbor Totoro 龍貓》
✗《Inception 全面啟動》《Whiplash 進擊的鼓手》（太需要專注）

## 心動的感覺
看了會臉紅、有戀愛的悸動感、初戀感、曖昧感。
✓《Before Sunrise 愛在黎明破曉時》《你的名字。》《Past Lives 之前的我們》《我的少女時代》
✗《Marriage Story 婚姻故事》（已經過了戀愛期）《Blue Valentine》（太苦）

## 暖暖的就好
溫柔、療癒、家庭感、不沉重的暖心片。
✓《Little Forest 小森食光》《Whisper of the Heart 心之谷》《Paddington 2》《橫山家之味》
✗ 重劇情片、悲傷片

## 有點寂寞
寂寥、孤獨、安靜的憂傷、城市疏離感。
✓《Lost in Translation 愛情，不用翻譯》《In the Mood for Love 花樣年華》《Drive 落日車神》《Her》
✗ 群像熱鬧的片

## 想談戀愛
看完會想戀愛、嚮往愛情、浪漫憧憬。
✓《La La Land 樂來越愛你》《春嬌與志明》《About Time 真愛每一天》《向左走向右走》
✗ 黑暗系、苦戀系愛情片（那是「想愛又怕受傷」）

## 躺著看就好
純娛樂、不用動腦、爽片、笑就對了。
✓ Marvel 超英雄、《捍衛戰士》系列、無厘頭喜劇、Jackie Chan 早期動作片
✗ Tarkovsky、Bergman、任何沉重作者電影

## 需要被療癒
心累時想看、被作品溫柔抱住的感覺，比「暖暖的就好」更暗示觀眾本來受傷。
✓《Soul 靈魂急轉彎》《Paterson》《About Time》《Inside Out 腦筋急轉彎》《橫道世之介》
✗ 燒腦片、驚悚片、純娛樂爽片

## 好想哭
催淚片、看了會流淚、悲傷被觸動。一般程度的悲傷感。
✓《Manchester by the Sea 海邊的曼徹斯特》《海街日記》《Coco 可可夜總會》《Marley & Me》
✗《Inception》（智性而非情緒）《動作片》（純爽快）

## 想哭一場
比「好想哭」更重更深、想要被狠狠戳到、強烈情緒釋放。是「我今天就是要大哭一場」的需求。
✓《Grave of the Fireflies 螢火蟲之墓》《Requiem for a Dream 噩夢輓歌》《花樣年華》（最痛的時刻）《Dancer in the Dark 在黑暗中漫舞》
✗ Pixar（太溫柔）、一般愛情片（太薄）、所有「好想哭」就夠用的片

## 很有壓迫感
看完會喘不過氣、心理壓力大、密集焦慮、節奏密。
✓《Uncut Gems 原鑽》《Whiplash 進擊的鼓手》《Parasite 寄生上流》《Burning 燃燒烈愛》《Funny Games 大快人心》
✗ 普通驚悚片（有刺激但不夠密）、Marvel 動作片

## 想愛又怕受傷
苦戀、愛情創傷、矛盾的愛、知道會痛還是愛了、無法在一起。
✓《Call Me By Your Name 以你的名字呼喚我》《Past Lives 之前的我們》《春光乍洩》《In the Mood for Love》《Blue Valentine》
✗ 純爽愛情片、《La La Land》（那是「想談戀愛」）

# 風格 tags（描述電影本身的調性）

## 想看點怪的
非主流、奇怪、邊緣、cult、實驗性、風格獨特。
✓《Eraserhead 橡皮頭》《Synecdoche, New York》《The Lighthouse 燈塔》《Holy Motors》
✗ 主流商業片

## 這世界很荒謬
荒誕、超現實、諷刺、世界本身就壞了的喜劇感。
✓《The Lobster 單身動物園》《Sorry to Bother You》《Triangle of Sadness 瘋狂富作用》《Dr. Strangelove 奇愛博士》
✗ 寫實主義片

## 政治
政治題材、權力結構、政府/體制衝突。
✓《The Trial of the Chicago 7》《JFK 誰殺了甘迺迪》《辯護人》《1987：黎明到來的那一天》
✗ 純愛情/家庭片

## 世界毀了也無所謂
虛無、末世、犬儒、人類沒救了。
✓《Melancholia 驚悚末日》《Children of Men 人類之子》《The Road 末路浩劫》《Dr. Strangelove》
✗ 充滿希望的片、勵志片

## 社會
社會議題、階級、貧富、邊緣群體、結構性不公。
✓《Parasite 寄生上流》《Nomadland 游牧人生》《I, Daniel Blake 我是布萊克》《大佛普拉斯》
✗ 純逃避現實娛樂片

## 想念那時候
懷舊、時代片、回憶感、特定年代的氣味。
✓《Roma 羅馬》《Once Upon a Time in Hollywood》《那些年，我們一起追的女孩》《新天堂樂園》
✗ 現代背景的片

## 經典
公認的影史名作、必看清單上會出現的、世代代表作。
✓《Citizen Kane 大國民》《一一》《2001: A Space Odyssey》《The Shining 鬼店》《教父》
✗ 一般商業片、近年話題作（除非已被公認為經典）

## 冒險
旅程、探索、出發、公路片風格。
✓《Indiana Jones 法櫃奇兵》《The Lord of the Rings 魔戒》《Into the Wild 阿拉斯加之死》《Easy Rider 逍遙騎士》
✗ 室內劇情片、家庭倫理片

## 文藝
作者電影、文學感、詩意、慢節奏、影像優先於情節。
✓ 楊德昌、Tarkovsky、王家衛、Bergman、是枝裕和、《Tree of Life 永生樹》
✗ 純爆米花片、純商業類型片

## 越燒越好
慢燃懸疑、層層揭開、看完還要想三天。
✓《Memories of Murder 殺人回憶》《Zodiac 索命黃道帶》《Mulholland Drive 穆荷蘭大道》《Burning 燃燒烈愛》
✗ 當下就解開的速食懸疑片

# 輸出格式

回傳 JSON：
\`\`\`
{
  "reasoning": "1-2 句話說明為什麼選這些 tag（用中文）",
  "mood_style_tags": [
    {"name": "<受控詞彙之一>", "weight": 1.0 或 2.0},
    ...
  ]
}
\`\`\`

如果這部片真的沒有合適的情緒/風格 tag（例如純動作爽片、紀錄片內容太特殊），\`mood_style_tags\` 給空陣列 []，這是合理的。

# 完整範例（學會推導方式）

## 範例 1：《Whiplash 進擊的鼓手》（2014）
類型 tag：劇情
劇情：青年鼓手在頂尖音樂院追求卓越，遭遇魔鬼導師折磨。
推導：核心氛圍是壓迫感（密集焦慮、心理壓力大），這是這部片最強烈的特質給 2.0。情緒張力強到看完不想說話，「想哭一場」適用 1.0。文藝感不夠強（節奏太密），不選。
輸出：
{
  "reasoning": "這部片的核心就是壓迫感，魔鬼導師的精神壓榨是電影主軸；情緒張力高到看完想哭一場。",
  "mood_style_tags": [
    {"name": "很有壓迫感", "weight": 2.0},
    {"name": "想哭一場", "weight": 1.0}
  ]
}

## 範例 2：《Coco 可可夜總會》（2017）
類型 tag：奇幻、家庭、動畫
劇情：墨西哥男孩追尋音樂夢，誤入亡靈世界與家族先人重逢。
推導：核心是溫暖的家庭情感與療癒感，weight 2.0。會哭但不重，給「好想哭」1.0 而不給「想哭一場」（後者更深更痛）。墨西哥傳統有懷舊感但不是主軸，不選「想念那時候」。
輸出：
{
  "reasoning": "Pixar 動畫，核心氛圍是家庭溫暖與療癒，會落淚但屬於溫和眼淚而非劇烈情緒釋放。",
  "mood_style_tags": [
    {"name": "暖暖的就好", "weight": 2.0},
    {"name": "需要被療癒", "weight": 1.0},
    {"name": "好想哭", "weight": 1.0}
  ]
}

## 範例 3：《捍衛戰士：獨行俠 Top Gun: Maverick》（2022）
類型 tag：動作
劇情：頂尖飛行員培訓新一代為高難度任務做準備。
推導：純爽片，沒有深刻情緒議題。「躺著看就好」是代表性，2.0。飛行訓練與任務帶冒險元素，1.0。其他都不貼。
輸出：
{
  "reasoning": "純粹的動作爽片，視覺奇觀為主，看完就是爽，沒有需要消化的情緒議題。",
  "mood_style_tags": [
    {"name": "躺著看就好", "weight": 2.0},
    {"name": "冒險", "weight": 1.0}
  ]
}

## 範例 4：《Tár 塔爾》（2022）
類型 tag：劇情
劇情：知名古典樂指揮家在權勢頂峰時面臨醜聞與崩潰。
推導：作者氣息強烈、節奏緩、影像優先，文藝 2.0。隨情節推進真相一層層揭開，越燒越好 1.0。心理壓迫感隨醜聞累積，1.0。看完不會哭但會無語，不選情緒類。
輸出：
{
  "reasoning": "Todd Field 作者電影，文學感與緩慢節奏並重；隨情節推進壓迫感逐漸累積，看完還要回想。",
  "mood_style_tags": [
    {"name": "文藝", "weight": 2.0},
    {"name": "越燒越好", "weight": 1.0},
    {"name": "很有壓迫感", "weight": 1.0}
  ]
}

## 範例 5：《捍衛任務 John Wick》（2014）
類型 tag：動作、犯罪
劇情：退休殺手為愛犬被殺復仇，重返地下殺手世界。
推導：純動作型暴力美學，劇情簡單。給 1 個「躺著看就好」就夠。其他類別都不適合（不悲不暖不文藝不政治）。
輸出：
{
  "reasoning": "純動作奇觀，類型 tag 已足以描述電影特性，加 1 個躺著看的標籤即可。",
  "mood_style_tags": [
    {"name": "躺著看就好", "weight": 1.0}
  ]
}

## 範例 6：《Past Lives 之前的我們》（2023）
類型 tag：劇情
劇情：童年好友 24 年後在紐約重逢，思考錯過的愛情與身分認同。
推導：核心是「想愛又怕受傷」（明知無法在一起的苦戀），2.0。寂寥的個人感受給「有點寂寞」1.0。文藝節奏緩、影像詩意，1.0。會落淚給「好想哭」1.0。
輸出：
{
  "reasoning": "苦戀電影代表作，安靜而深刻地處理錯過、身分認同與時間流逝的命題。",
  "mood_style_tags": [
    {"name": "想愛又怕受傷", "weight": 2.0},
    {"name": "有點寂寞", "weight": 1.0},
    {"name": "文藝", "weight": 1.0},
    {"name": "好想哭", "weight": 1.0}
  ]
}

## 範例 7：《辯護人》（2013）
類型 tag：劇情
劇情：1980 年代韓國，律師為被指控為共產黨員的學生辯護。
推導：政治題材直接 2.0。社會結構問題 1.0。1980 年代背景帶懷舊感 1.0。情緒上會激動但不是「好想哭」式的悲傷。
輸出：
{
  "reasoning": "韓國民主化時代政治法庭片，直面威權體制與司法不公，年代背景強。",
  "mood_style_tags": [
    {"name": "政治", "weight": 2.0},
    {"name": "社會", "weight": 1.0},
    {"name": "想念那時候", "weight": 1.0}
  ]
}
`

// ── Zod schema ─────────────────────────────────────────────
const ResultSchema = z.object({
  reasoning: z.string(),
  mood_style_tags: z.array(z.object({
    name: z.string(),  // 不用 enum，避免 LLM 偶發 drift 觸發 throw；下游用 VALID_TAGS 過濾
    weight: z.number(),
  })),
})

// ── Directus helpers ───────────────────────────────────────
async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD}),
  }).then(r => r.json())
  if (!r.data?.access_token) { console.error('❌ Directus 登入失敗', r); process.exit(1) }
  return r.data.access_token
}

async function directus(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  })
  return r.json()
}

// Directus access token TTL = 15 分鐘；長批次必須主動更新避免中途過期
let _token = null
let _loginAt = 0
const TOKEN_REFRESH_MS = 12 * 60 * 1000  // 12 分鐘換新

async function ensureToken() {
  if (!_token || Date.now() - _loginAt > TOKEN_REFRESH_MS) {
    _token = await login()
    _loginAt = Date.now()
  }
  return _token
}

async function dirAuth(method, path, body) {
  let tok = await ensureToken()
  let r = await directus(tok, method, path, body)
  // 反應式 fallback：若仍 Token expired（例如 server clock skew），強制重登再試一次
  if (r.errors?.[0]?.message?.includes('Token expired') || r.errors?.[0]?.extensions?.code === 'TOKEN_EXPIRED') {
    _token = await login()
    _loginAt = Date.now()
    r = await directus(_token, method, path, body)
  }
  return r
}

// ── TMDB helper ────────────────────────────────────────────
async function fetchOverview(originalTitle, year) {
  const q = encodeURIComponent(originalTitle)
  try {
    let data = await fetch(`${TMDB_BASE}/search/movie?query=${q}&year=${year}&language=zh-TW&api_key=${TMDB_KEY}`).then(r => r.json())
    let hit = data.results?.[0]
    let overview = hit?.overview
    // 沒有 zh-TW overview → fallback to English
    if (hit && !overview?.trim()) {
      const en = await fetch(`${TMDB_BASE}/movie/${hit.id}?api_key=${TMDB_KEY}`).then(r => r.json())
      overview = en.overview
    }
    return overview?.trim() || null
  } catch {
    return null
  }
}

// ── LLM call ───────────────────────────────────────────────
async function tagOneMovie(client, movie, overview, currentMoodStyleTags) {
  const userPrompt = `片名：${movie.title}（${movie.original_title}, ${movie.year}）
現有類型 tag：${movie.genreTags.join('、') || '（無）'}

劇情簡介：
${overview}

請判定這部片的情緒/風格 tag。`

  const response = await client.messages.parse({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: [
      { type: 'text', text: TAXONOMY, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userPrompt }],
    output_config: { format: zodOutputFormat(ResultSchema) },
  })
  return response
}

// ── Progress tracking ──────────────────────────────────────
function loadProgress() {
  if (RESET || !existsSync(PROGRESS_FILE)) return new Set()
  return new Set(readFileSync(PROGRESS_FILE, 'utf-8').split('\n').filter(Boolean))
}

function markProgress(id) {
  if (DRY_RUN) return
  mkdirSync(dirname(PROGRESS_FILE), {recursive: true})
  appendFileSync(PROGRESS_FILE, id + '\n')
}

if (RESET && existsSync(PROGRESS_FILE)) {
  writeFileSync(PROGRESS_FILE, '')
  console.log('🔄 已清空進度檔\n')
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN — 不寫回 Directus\n' : '✍️  正式模式 — 會寫回 Directus\n')

  await ensureToken()
  console.log('✓ Directus 登入成功（auto-refresh 啟用）')

  const tagsRes = await dirAuth('GET', '/items/tags?limit=-1&fields=id,name,category')
  const tagByName = Object.fromEntries(tagsRes.data.map(t => [t.name, t]))
  console.log(`✓ 載入 ${tagsRes.data.length} 個 tag`)

  // 驗證所有 VALID_TAGS 都存在於 Directus
  const missing = VALID_TAGS.filter(n => !tagByName[n])
  if (missing.length) {
    console.error(`❌ Directus 找不到這些 tag: ${missing.join(', ')}`)
    process.exit(1)
  }

  const moviesRes = await dirAuth('GET',
    '/items/movies?limit=-1&fields=id,title,original_title,year,tags.id,tags.weight,tags.tags_id.id,tags.tags_id.name,tags.tags_id.category')
  const allMovies = moviesRes.data
  console.log(`✓ 載入 ${allMovies.length} 部電影\n`)

  const processed = loadProgress()
  if (processed.size > 0) console.log(`⏭️  已處理 ${processed.size} 部，將略過\n`)

  const todoMovies = allMovies.filter(m => !processed.has(m.id)).slice(0, LIMIT)
  console.log(`📥 本次處理：${todoMovies.length} 部\n`)

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

  let succeeded = 0, skipped = 0, failed = 0
  let totalCacheRead = 0, totalCacheWrite = 0, totalUncachedIn = 0, totalOut = 0

  for (const [i, m] of todoMovies.entries()) {
    const idx = `[${i + 1}/${todoMovies.length}]`
    const genreTags = m.tags.filter(t => t.tags_id?.category === '類型').map(t => t.tags_id.name)
    const moodStyleJunctions = m.tags.filter(t => t.tags_id?.category === '情緒' || t.tags_id?.category === '風格')
    const movieCtx = { ...m, genreTags }

    // 1. TMDB overview
    const overview = await fetchOverview(m.original_title, m.year)
    if (!overview) {
      console.log(`${idx} ⊘ 無 TMDB overview，跳過：${m.title}`)
      skipped++
      continue
    }

    // 2. LLM call
    let result
    try {
      result = await tagOneMovie(client, movieCtx, overview, moodStyleJunctions.map(t => t.tags_id.name))
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        console.error(`${idx} ⏸ Rate limit；暫停 60s 後跳過：${m.title}`)
        await new Promise(r => setTimeout(r, 60_000))
      } else if (err instanceof Anthropic.APIError) {
        console.error(`${idx} ✗ API 錯 ${err.status}: ${m.title}`)
      } else {
        console.error(`${idx} ✗ 未預期錯誤：${m.title}`, err.message)
      }
      failed++
      continue
    }

    const u = result.usage
    totalCacheRead += u.cache_read_input_tokens ?? 0
    totalCacheWrite += u.cache_creation_input_tokens ?? 0
    totalUncachedIn += u.input_tokens
    totalOut += u.output_tokens

    if (!result.parsed_output) {
      console.log(`${idx} ✗ LLM 拒答或格式錯：${m.title}`)
      failed++
      continue
    }

    const newTags = result.parsed_output.mood_style_tags
      .filter(t => VALID_TAGS.includes(t.name))
      .map(t => ({ name: t.name, weight: t.weight === 2 ? 2.0 : 1.0 }))

    // 印進度（前 5 部詳細，之後每 10 部一次）
    const verbose = i < 5 || i % 10 === 0
    if (verbose || DRY_RUN) {
      const cacheHit = (u.cache_read_input_tokens ?? 0) > 0 ? '✓cached' : (u.cache_creation_input_tokens > 0 ? '✎writing' : '✗no-cache')
      console.log(`${idx} ${m.title}（${m.year}）${cacheHit}`)
      console.log(`     reasoning: ${result.parsed_output.reasoning}`)
      console.log(`     ${newTags.length > 0 ? newTags.map(t => `${t.name}(${t.weight})`).join('、') : '（沒有適合的 mood/style tag）'}`)
    } else {
      process.stdout.write(`${idx} ${m.title.padEnd(20)} → ${newTags.length} tags\r`)
    }

    // 3. 寫回 Directus（除非 dry-run）
    if (!DRY_RUN) {
      const patch = {
        tags: {
          create: newTags.map(t => ({ tags_id: { id: tagByName[t.name].id }, weight: t.weight })),
          delete: moodStyleJunctions.map(j => j.id),
          update: [],
        }
      }
      const r = await dirAuth('PATCH', `/items/movies/${m.id}`, patch)
      if (r.errors) {
        console.error(`${idx} ✗ Directus PATCH 失敗：${m.title}`, r.errors[0]?.message)
        failed++
        continue
      }
    }

    succeeded++
    markProgress(m.id)
  }

  console.log('\n\n=== 結果 ===')
  console.log(`成功：${succeeded}  跳過：${skipped}  失敗：${failed}`)
  console.log('\n=== Token 用量（Haiku 4.5）===')
  console.log(`  cache read:   ${totalCacheRead.toLocaleString()}`)
  console.log(`  cache write:  ${totalCacheWrite.toLocaleString()}`)
  console.log(`  input:        ${totalUncachedIn.toLocaleString()}`)
  console.log(`  output:       ${totalOut.toLocaleString()}`)

  // Haiku 4.5 定價：$1/MTok in, $5/MTok out, $0.10/MTok cached read, $1.25/MTok cache write
  const cost = totalCacheRead * 0.10/1e6 + totalCacheWrite * 1.25/1e6 + totalUncachedIn * 1.00/1e6 + totalOut * 5.00/1e6
  console.log(`\n預估成本：$${cost.toFixed(4)}`)

  if (totalCacheRead === 0 && succeeded > 1) {
    console.log('\n⚠️  cache_read 為 0 — taxonomy 可能 <4096 token，或有 silent invalidator。')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
