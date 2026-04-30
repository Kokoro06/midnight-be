#!/usr/bin/env node
// 將 Directus tags collection 的舊名稱 rename 為新名稱
const DIRECTUS_URL = 'http://localhost:8055'
const EMAIL = 'anyustudio@gmail.com'
const PASSWORD = 'midnight2026!'

const RENAME_MAP = {
  '愛情': '想談戀愛',
  '寂寞': '有點寂寞',
  '憂鬱': '好想哭',
  '療癒': '需要被療癒',
  '溫馨': '暖暖的就好',
  '浪漫': '心動的感覺',
  '平靜': '靜靜看就好',
  '青春': '想念那時候',
  'LGBTQ': '酷兒',
  '末日': '世界毀了也無所謂',
  '邪典': '想看點怪的',
  '燒腦': '越燒越好',
  '諷刺': '這世界很荒謬',
  '放鬆': '躺著看就好',
}

async function main() {
  // 1. 登入取得 token
  const loginRes = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const { data: auth } = await loginRes.json()
  if (!auth?.access_token) {
    console.error('登入失敗', await loginRes.text())
    process.exit(1)
  }
  const token = auth.access_token
  console.log('✓ 登入成功')

  // 2. 取得所有 tags
  const tagsRes = await fetch(`${DIRECTUS_URL}/items/tags?limit=-1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const { data: tags } = await tagsRes.json()
  if (!tags) { console.error('無法取得 tags'); process.exit(1) }
  console.log(`✓ 取得 ${tags.length} 個 tags`)

  // 3. 逐一 rename
  let updated = 0
  let skipped = 0
  for (const tag of tags) {
    const newName = RENAME_MAP[tag.name]
    if (!newName) { skipped++; continue }

    const patchRes = await fetch(`${DIRECTUS_URL}/items/tags/${tag.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: newName }),
    })
    if (patchRes.ok) {
      console.log(`  ${tag.name} → ${newName}`)
      updated++
    } else {
      console.error(`  ✗ 更新 "${tag.name}" 失敗:`, await patchRes.text())
    }
  }

  console.log(`\n完成：更新 ${updated} 個，略過 ${skipped} 個`)
}

main().catch((e) => { console.error(e); process.exit(1) })
