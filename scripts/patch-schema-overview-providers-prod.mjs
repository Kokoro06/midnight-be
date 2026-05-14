// patch-schema-overview-providers-prod.mjs
// 為正式區 movies collection 補齊 overview / justwatch_url / tmdb_id 三個欄位。
// 已存在的欄位會 skip，所以可以安全地對已手動補過的正式區重跑。
//
// 用法：
//   PROD_ADMIN_EMAIL=... PROD_ADMIN_PASSWORD=... \
//   node midnight-be/scripts/patch-schema-overview-providers-prod.mjs

const BASE = process.env.PROD_DIRECTUS_URL ?? 'https://mmoodvie.live'
const EMAIL = process.env.PROD_ADMIN_EMAIL
const PASSWORD = process.env.PROD_ADMIN_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error('❌ 缺少 PROD_ADMIN_EMAIL / PROD_ADMIN_PASSWORD')
  process.exit(1)
}

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
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
  console.log(`🎯 target: ${BASE}`)
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

  console.log('\n🔓 檢查 Public role 是否能讀新欄位...')
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
    console.log('  skip: 無 public read policy（若 backfill 完前端拿不到，到 admin 手動開放 read）')
  }

  console.log('\n✅ Schema patch 完成')
}

main().catch(e => { console.error(e); process.exit(1) })
