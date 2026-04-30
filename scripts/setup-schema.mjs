// setup-schema.mjs — Phase 10-A Schema 升級
// 執行: node midnight-be/scripts/setup-schema.mjs
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

const BASE = 'http://localhost:8055'

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

async function fieldExists(token, collection, field) {
  const res = await api(token, 'GET', `/fields/${collection}/${field}`)
  return !res.errors
}

async function addField(token, collection, fieldDef) {
  const exists = await fieldExists(token, collection, fieldDef.field)
  if (exists) {
    console.log(`  skip: ${collection}.${fieldDef.field} (已存在)`)
    return false
  }
  const res = await api(token, 'POST', `/fields/${collection}`, fieldDef)
  if (res.errors) {
    console.error(`  ✗ 新增 ${collection}.${fieldDef.field} 失敗:`, JSON.stringify(res.errors))
    return false
  }
  console.log(`  ✓ 新增 ${collection}.${fieldDef.field}`)
  return true
}

async function main() {
  console.log('🔐 登入 Directus...')
  const token = await login()
  console.log('  ✓ 登入成功\n')

  // ── 1. movies_tags.weight ────────────────────────────────
  console.log('📐 新增 movies_tags.weight...')
  await addField(token, 'movies_tags', {
    field: 'weight',
    type: 'float',
    schema: {
      default_value: 1.0,
      is_nullable: false,
    },
    meta: {
      note: 'Tag relevance weight: 2.0=primary genre, 1.0=secondary',
      hidden: false,
    },
  })

  // ── 2. 初始化現有 movies_tags 記錄為 weight = 1.0 ─────────
  console.log('\n🔧 初始化現有 junction 記錄 weight = 1.0...')
  const { data: junctions } = await api(token, 'GET', '/items/movies_tags?limit=-1&fields=id,weight')
  const needsInit = (junctions ?? []).filter(j => j.weight == null)

  if (needsInit.length === 0) {
    console.log('  skip: 所有記錄已有 weight 值')
  } else {
    const ids = needsInit.map(j => j.id)
    const res = await api(token, 'PATCH', '/items/movies_tags', {
      keys: ids,
      data: { weight: 1.0 },
    })
    if (res.errors) {
      console.error('  ✗ 批次更新失敗:', JSON.stringify(res.errors))
    } else {
      console.log(`  ✓ 初始化 ${ids.length} 筆 junction 記錄`)
    }
  }

  // ── 3. movies.poster_url ─────────────────────────────────
  console.log('\n📐 新增 movies.poster_url...')
  await addField(token, 'movies', {
    field: 'poster_url',
    type: 'string',
    schema: {
      is_nullable: true,
      default_value: null,
    },
    meta: {
      note: 'External poster URL (e.g. TMDB). Takes priority over poster UUID field.',
    },
  })

  // ── 4. Public role 確認 movies_tags weight 可 Read ────────
  console.log('\n🔑 確認 Public role 權限...')
  const { data: policies } = await api(token, 'GET', '/policies?filter[name][_eq]=Public&limit=1')
  if (!policies?.length) {
    console.log('  ⚠ 找不到 Public policy，請手動確認 movies_tags 和 movies 的 Read 權限包含新欄位')
  } else {
    console.log('  ℹ 欄位新增後 Directus 會自動繼承 collection-level 的 Read 權限（若已開啟）')
    console.log('  ✓ 請在 Directus Admin → Settings → Access Control → Public 確認')
  }

  console.log('\n✅ Schema 升級完成！')
  console.log('   下一步: 更新 directus.ts 型別，然後執行 import-tmdb.mjs')
}

main().catch(err => {
  console.error('執行失敗:', err)
  process.exit(1)
})
