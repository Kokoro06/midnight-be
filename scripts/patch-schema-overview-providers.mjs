// patch-schema-overview-providers.mjs
// 為 movies collection 新增 overview / justwatch_url / tmdb_id 三個欄位
//
// 執行：node midnight-be/scripts/patch-schema-overview-providers.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf-8')
    .split('\n').filter(l => l.includes('='))
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

  console.log('📐 新增 movies.tmdb_id...')
  await addField(token, 'movies', {
    field: 'tmdb_id',
    type: 'integer',
    schema: { is_nullable: true },
    meta: {
      note: 'TMDB movie id; reuse for trailer/cast/providers lookups',
      hidden: false,
      interface: 'input',
    },
  })

  console.log('\n📐 新增 movies.overview...')
  await addField(token, 'movies', {
    field: 'overview',
    type: 'text',
    schema: { is_nullable: true },
    meta: {
      note: 'TMDB zh-TW overview (fallback en); 顯示於 Result 卡片',
      hidden: false,
      interface: 'input-multiline',
    },
  })

  console.log('\n📐 新增 movies.justwatch_url...')
  await addField(token, 'movies', {
    field: 'justwatch_url',
    type: 'string',
    schema: { is_nullable: true, max_length: 500 },
    meta: {
      note: 'TMDB watch/providers TW link (JustWatch aggregator)',
      hidden: false,
      interface: 'input',
    },
  })

  console.log('\n🔓 開放 Public role 讀取新欄位...')
  // Directus 11 預設 collection-level permissions 已套用到所有欄位；
  // 但若 permission rule 有指定 fields 白名單，需要 patch 進去。先檢查 movies 的 public read policy。
  const policies = await api(token, 'GET', '/permissions?filter[collection][_eq]=movies&filter[action][_eq]=read&filter[role][_null]=true')
  if (policies.data?.length > 0) {
    const p = policies.data[0]
    if (Array.isArray(p.fields) && !p.fields.includes('*')) {
      const newFields = [...new Set([...p.fields, 'tmdb_id', 'overview', 'justwatch_url'])]
      const r = await api(token, 'PATCH', `/permissions/${p.id}`, { fields: newFields })
      if (r.errors) console.error('  ✗ 更新 public read fields 失敗:', JSON.stringify(r.errors))
      else console.log(`  ✓ public read fields 已加 3 個新欄位`)
    } else {
      console.log('  skip: public read 已是 * 或無欄位限制')
    }
  } else {
    console.log('  skip: 無 public read policy（你可能需要手動於 admin 開放）')
  }

  console.log('\n✅ Schema patch 完成')
}

main().catch(e => { console.error(e); process.exit(1) })
