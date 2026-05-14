// setup-festival-schema.mjs — 建立 festival_awards collection
// 執行: node midnight-be/scripts/setup-festival-schema.mjs
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

async function collectionExists(token, name) {
  const res = await api(token, 'GET', `/collections/${name}`)
  return !res.errors
}

async function fieldExists(token, collection, field) {
  const res = await api(token, 'GET', `/fields/${collection}/${field}`)
  return !res.errors
}

async function addField(token, collection, fieldDef) {
  if (await fieldExists(token, collection, fieldDef.field)) {
    console.log(`  skip: ${collection}.${fieldDef.field} （已存在）`)
    return
  }
  const res = await api(token, 'POST', `/fields/${collection}`, fieldDef)
  if (res.errors) {
    console.error(`  ✗ ${collection}.${fieldDef.field}:`, JSON.stringify(res.errors))
  } else {
    console.log(`  ✓ ${collection}.${fieldDef.field}`)
  }
}

async function getPublicPolicyId(token) {
  const res = await api(token, 'GET', '/policies?limit=20')
  const found = (res.data ?? []).find(
    (p) => p.name === 'Public' || p.name === '$t:public_label'
  )
  return found?.id ?? null
}

async function grantReadPermission(token, policyId, collection) {
  const existing = await api(
    token, 'GET',
    `/permissions?filter[policy][_eq]=${policyId}&filter[collection][_eq]=${collection}&filter[action][_eq]=read&limit=1`
  )
  if (existing.data?.length > 0) {
    console.log(`  skip: Public read on ${collection} （已存在）`)
    return
  }
  const res = await api(token, 'POST', '/permissions', {
    policy: policyId,
    collection,
    action: 'read',
    fields: ['*'],
  })
  if (res.errors) {
    console.error(`  ✗ 權限設定失敗 (${collection}):`, JSON.stringify(res.errors))
  } else {
    console.log(`  ✓ Public read on ${collection}`)
  }
}

async function main() {
  console.log('🔐 登入 Directus...')
  const token = await login()
  console.log('  ✓ 登入成功\n')

  // ── 1. 建立 festival_awards collection ──────────────────────
  console.log('📦 建立 festival_awards collection...')
  if (await collectionExists(token, 'festival_awards')) {
    console.log('  skip: festival_awards 已存在\n')
  } else {
    const res = await api(token, 'POST', '/collections', {
      collection: 'festival_awards',
      meta: {
        icon: 'emoji_events',
        note: '影展得獎與入圍紀錄',
        display_template: '{{festival}} {{year}} {{award_category}}',
      },
      schema: {},
      fields: [
        {
          field: 'id',
          type: 'uuid',
          meta: { hidden: true, readonly: true },
          schema: { is_primary_key: true, has_auto_increment: false },
        },
      ],
    })
    if (res.errors) {
      console.error('  ✗ 建立 collection 失敗:', JSON.stringify(res.errors))
      process.exit(1)
    }
    console.log('  ✓ festival_awards collection 建立完成\n')
  }

  // ── 2. 新增欄位 ──────────────────────────────────────────────
  console.log('📐 新增欄位...')

  await addField(token, 'festival_awards', {
    field: 'movie',
    type: 'uuid',
    schema: { is_nullable: false },
    meta: {
      interface: 'select-dropdown-m2o',
      display: 'related-values',
      display_options: { template: '{{title}}' },
      options: { template: '{{title}}' },
      note: '關聯至 movies collection',
    },
  })

  await addField(token, 'festival_awards', {
    field: 'festival',
    type: 'string',
    schema: { is_nullable: false },
    meta: {
      interface: 'select-dropdown',
      options: {
        choices: [
          { text: '金馬', value: '金馬' },
          { text: '台北電影節', value: '台北電影節' },
          { text: '高雄電影節', value: '高雄電影節' },
          { text: 'TIDF', value: 'TIDF' },
          { text: '女性影展', value: '女性影展' },
        ],
      },
      note: '影展名稱',
    },
  })

  await addField(token, 'festival_awards', {
    field: 'year',
    type: 'integer',
    schema: { is_nullable: false },
    meta: { note: '頒獎年份（例：2024）' },
  })

  await addField(token, 'festival_awards', {
    field: 'edition',
    type: 'integer',
    schema: { is_nullable: true },
    meta: { note: '屆次（例：61）；部分影展無屆次可留空' },
  })

  await addField(token, 'festival_awards', {
    field: 'award_category',
    type: 'string',
    schema: { is_nullable: false },
    meta: {
      note: '獎項名稱（例：最佳影片、最佳導演、台灣競賽首獎）',
    },
  })

  await addField(token, 'festival_awards', {
    field: 'result',
    type: 'string',
    schema: { is_nullable: false, default_value: 'nominated' },
    meta: {
      interface: 'select-dropdown',
      options: {
        choices: [
          { text: '得獎', value: 'won' },
          { text: '入圍', value: 'nominated' },
        ],
      },
      note: '得獎 (won) 或入圍 (nominated)',
    },
  })

  // ── 3. 設定 M2O 關聯（movies ← festival_awards） ────────────
  console.log('\n🔗 設定 M2O 關聯...')
  const relationRes = await api(token, 'POST', '/relations', {
    collection: 'festival_awards',
    field: 'movie',
    related_collection: 'movies',
    schema: { on_delete: 'CASCADE' },  // 刪 movie 連帶刪 awards（awards 只在 movie 上下文有意義）
  })
  if (relationRes.errors) {
    const msg = JSON.stringify(relationRes.errors)
    if (msg.includes('already exists') || msg.includes('UNIQUE') || msg.includes('already has an associated relationship')) {
      console.log('  skip: 關聯已存在')
    } else {
      console.error('  ✗ 關聯設定失敗:', msg)
    }
  } else {
    console.log('  ✓ festival_awards.movie → movies')
  }

  // ── 4. Public role 開放 Read ─────────────────────────────────
  console.log('\n🔑 設定 Public role 權限...')
  const policyId = await getPublicPolicyId(token)
  if (!policyId) {
    console.log('  ⚠ 找不到 Public policy，請手動在 Admin → Settings → Access Control 開放 festival_awards Read')
  } else {
    await grantReadPermission(token, policyId, 'festival_awards')
  }

  console.log('\n✅ festival_awards schema 建立完成！')
  console.log('   下一步: node midnight-be/scripts/seed-festivals.mjs')
}

main().catch(err => {
  console.error('執行失敗:', err)
  process.exit(1)
})
