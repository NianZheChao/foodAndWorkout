/**
 * 从工作区的 data/foods.csv 生成初始食物库种子文件。
 * 用法：node scripts/gen-seed.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const csvPath = join(appRoot, '..', 'data', 'foods.csv')
const outPath = join(appRoot, 'src', 'data', 'seed', 'foods.seed.ts')

/** 最小 CSV 解析：支持引号包裹与 "" 转义 */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1 } else { inQuotes = false }
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

const num = (raw, label, name) => {
  const v = Number(String(raw).trim())
  if (!Number.isFinite(v)) throw new Error(`${name} 的 ${label} 不是数字：${JSON.stringify(raw)}`)
  return v
}

const rows = parseCsv(readFileSync(csvPath, 'utf8'))
const header = rows[0].map((h) => h.trim())
const expected = ['name', 'category', 'unit', 'kcal', 'protein_g', 'fat_g', 'carb_g', 'fiber_g', 'sodium_mg', 'note']
for (const key of expected) {
  if (!header.includes(key)) throw new Error(`foods.csv 缺少列：${key}`)
}
const at = (name) => header.indexOf(name)

const items = []
const seen = new Set()
for (const raw of rows.slice(1)) {
  const name = raw[at('name')].trim()
  const unit = raw[at('unit')].trim()
  if (!unit) throw new Error(`${name} 缺少计量基准`)
  const note = raw[at('note')].trim() || undefined
  // 数值一律表示「每个基准单位」；非 100g/100ml 的基准必须在 note 里写清依据（DR-05）
  if (unit !== '100g' && unit !== '100ml' && !note) {
    throw new Error(`${name} 的基准是「${unit}」，必须在 note 列写明数值依据`)
  }
  if (seen.has(name)) throw new Error(`foods.csv 存在重名条目：${name}`)
  seen.add(name)
  items.push({
    name,
    category: raw[at('category')].trim(),
    unit,
    kcal: num(raw[at('kcal')], 'kcal', name),
    proteinG: num(raw[at('protein_g')], 'protein_g', name),
    fatG: num(raw[at('fat_g')], 'fat_g', name),
    carbG: num(raw[at('carb_g')], 'carb_g', name),
    fiberG: num(raw[at('fiber_g')], 'fiber_g', name),
    sodiumMg: num(raw[at('sodium_mg')], 'sodium_mg', name),
    note
  })
}

const version = `foods.csv@${new Date().toISOString().slice(0, 10)}`
const body = items
  .map((f) => {
    const parts = [
      `name: ${JSON.stringify(f.name)}`,
      `category: ${JSON.stringify(f.category)}`,
      `unit: ${JSON.stringify(f.unit)}`,
      `kcal: ${f.kcal}`,
      `proteinG: ${f.proteinG}`,
      `fatG: ${f.fatG}`,
      `carbG: ${f.carbG}`,
      `fiberG: ${f.fiberG}`,
      `sodiumMg: ${f.sodiumMg}`
    ]
    if (f.note) parts.push(`note: ${JSON.stringify(f.note)}`)
    return `  { ${parts.join(', ')} }`
  })
  .join(',\n')

const output = `/* 由 scripts/gen-seed.mjs 从 ../data/foods.csv 生成，请勿手改。 */
import type { SeedFood } from '@/data/repositories/foods'

export const FOOD_SEED_VERSION = ${JSON.stringify(version)}

export const FOOD_SEED_ROWS: SeedFood[] = [
${body}
]
`
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, output, 'utf8')
console.log(`已生成 ${items.length} 条食物种子 → ${outPath}`)