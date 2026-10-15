/**
 * 份量 → 克的折算。口径见 docs/pwa-design.md §5.1 / §5.2。
 *
 * 与工作区约定一致（AGENTS.md「份量不明确时按常见值估算，并写明假设」）：
 * 折算依据分四级，越靠前越可信；走到 `assumed` 时调用方应当把 note 展示给用户，
 * 走到 `unknown` 时必须追问（需求 DR-47 / DR-49），不允许凭空给一个克数。
 */

import type { Amount, Food, PortionBasis } from '@/domain/types'

export type PortionBasisKind =
  /** 输入里直接写了总克重，如「2只(100g)」 */
  | 'explicit'
  /** 单位本身就是质量 / 体积，如「80g」「250ml」 */
  | 'mass'
  /** 与食物条目的计量基准一致，如「2个」对 unit=个 的条目 */
  | 'foodBasis'
  /** 命中食物条目自己的份量表 */
  | 'foodPortion'
  /** 按常见值估算，需要向用户确认 */
  | 'assumed'
  /** 无法折算，必须追问 */
  | 'unknown'

export interface ResolvedPortion extends Amount {
  basis: PortionBasisKind
  /** 折算依据说明；`assumed` / `unknown` 时必有值 */
  note?: string
}

/** 解析结果：数量 + 计量词，可能附带输入里显式给出的总克重。 */
export interface ParsedPortion {
  qty: number
  unit: string
  /** 括号里的总克重，如「2只(100g)」的 100 */
  explicitGrams?: number
}

const MASS_UNITS = new Set(['g', '克', 'gram', 'grams', 'ml', '毫升', 'cc', 'ml.'])

/** 常见计量词的默认克重。仅用于「assumed」兜底，会在界面上标注为估算。 */
export const DEFAULT_PORTION_GRAMS: Record<string, number> = {
  碗: 150,
  个: 50,
  只: 50,
  片: 30,
  杯: 200,
  勺: 15,
  块: 40,
  根: 80,
  条: 60,
  把: 100,
  份: 200,
  盒: 250,
  袋: 100,
  瓶: 500,
  听: 330,
  罐: 330
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
}

/** 全角括号、逗号与空白统一，便于后续正则。 */
function normalizePortionText(input: string): string {
  return input
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[\uff0c,]/g, ',')
    .replace(/\s+/g, '')
    .trim()
}

/** 解析数量：支持阿拉伯数字、`半`、以及 `十`/`十六`/`二十`/`二十三`。 */
export function parseQuantity(raw: string): number | undefined {
  const text = raw.trim()
  if (!text) return undefined
  if (text === '半') return 0.5
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (!/^[零一二两三四五六七八九十]+$/.test(text)) return undefined
  if (text.length === 1) return CN_DIGITS[text]
  if (text.length === 2 && text[0] === '十') return 10 + CN_DIGITS[text[1]]
  if (text.length === 2 && text[1] === '十') return CN_DIGITS[text[0]] * 10
  const index = text.indexOf('十')
  if (index < 0 || text.length !== 3 || index !== 1) return undefined
  const tens = CN_DIGITS[text[0]]
  const ones = CN_DIGITS[text[2]]
  if (tens === undefined || ones === undefined) return undefined
  return tens * 10 + ones
}

function toQty(raw: string): number | undefined {
  return parseQuantity(raw)
}

/**
 * 解析用户输入的份量文本。识别不了返回 undefined（调用方走追问）。
 *
 * 支持的写法：`100g`、`250ml`、`80克`、`2只`、`2只(100g)`、`330g(整盒)`、
 * `一碗(150g)`、`1.5份`、`3个`。
 */
export function parsePortionInput(input: string): ParsedPortion | undefined {
  const text = normalizePortionText(input)
  if (!text) return undefined

  // 先剥掉尾部括号：`2只(100g)` 的克重、`330g(整盒)` 的包装说明都在括号里。
  // 括号里没有数字（如「整盒」「约」）时不算显式克重。
  let head = text
  let explicitGrams: number | undefined
  const paren = /^(.*?)\(([^)]*)\)$/.exec(text)
  if (paren) {
    head = paren[1]
    const inner = /(\d+(?:\.\d+)?)/.exec(paren[2])
    if (inner) explicitGrams = Number(inner[1])
  }

  // 纯质量 / 体积：100g、250ml、80克
  const massOnly = /^(\d+(?:\.\d+)?)(g|克|ml|毫升|cc)$/i.exec(head)
  if (massOnly) return { qty: Number(massOnly[1]), unit: massOnly[2].toLowerCase(), explicitGrams }

  // 数量 + 计量词：2只、一碗、1.5份
  const withUnit = /^([\d.]+|[半零一二两三四五六七八九十]+)(.*)$/.exec(head)
  if (withUnit) {
    const qty = toQty(withUnit[1])
    const unit = withUnit[2]
    // 中文数字前缀极易误伤自由文本（「一点点」会被读成 1「点点」），
    // 因此中文数字后面必须跟一个已知计量词；阿拉伯数字则放宽到任意短单位。
    const isChineseNumeral = !/^[\d.]+$/.test(withUnit[1])
    const knownUnit = unit in DEFAULT_PORTION_GRAMS || isMassUnit(unit)
    if (qty !== undefined && unit && unit.length <= 3 && (!isChineseNumeral || knownUnit)) {
      return { qty, unit, explicitGrams }
    }
  }

  // 只有数字：按「份」计（会走 assumed 分支，界面必须让用户确认）
  const bare = toQty(head)
  if (bare !== undefined) return { qty: bare, unit: '份', explicitGrams }

  return undefined
}

function isMassUnit(unit: string): boolean {
  return MASS_UNITS.has(unit.toLowerCase())
}

/** 在食物条目自带的份量表里找一个能匹配计量词的基准。 */
function matchFoodPortion(portions: PortionBasis[] | undefined, unit: string): PortionBasis | undefined {
  if (!portions?.length) return undefined
  return portions.find((p) => p.label.includes(unit) || unit.includes(p.label))
}

/**
 * 把份量文本折算成克数。
 *
 * @param input 用户输入的份量，如 `2只(100g)`
 * @param food  选中的食物条目；只用到 unit / basisGrams / portions，因此可以传快照
 */
export function resolvePortion(
  input: string,
  food?: Pick<Food, 'unit' | 'basisGrams' | 'portions'>
): ResolvedPortion {
  const parsed = parsePortionInput(input)
  if (!parsed) {
    return { qty: 0, unit: '', basis: 'unknown', note: `无法识别份量「${input}」，请补充克数或件数` }
  }

  if (parsed.explicitGrams !== undefined) {
    return {
      qty: parsed.qty,
      unit: parsed.unit,
      grams: parsed.explicitGrams,
      basis: 'explicit',
      note: `按输入的 ${parsed.explicitGrams} g 计`
    }
  }

  if (isMassUnit(parsed.unit)) {
    return { qty: parsed.qty, unit: parsed.unit, grams: parsed.qty, basis: 'mass' }
  }

  if (food?.basisGrams && parsed.unit === food.unit) {
    return {
      qty: parsed.qty,
      unit: parsed.unit,
      grams: parsed.qty * food.basisGrams,
      basis: 'foodBasis',
      note: `按 1${food.unit} ≈ ${food.basisGrams} g 折算`
    }
  }

  const matched = matchFoodPortion(food?.portions, parsed.unit)
  if (matched) {
    return {
      qty: parsed.qty,
      unit: parsed.unit,
      grams: parsed.qty * matched.grams,
      basis: 'foodPortion',
      note: `按 ${matched.label} ≈ ${matched.grams} g 折算`
    }
  }

  const assumed = DEFAULT_PORTION_GRAMS[parsed.unit]
  if (assumed) {
    return {
      qty: parsed.qty,
      unit: parsed.unit,
      grams: parsed.qty * assumed,
      basis: 'assumed',
      note: `按常见量估算：1${parsed.unit} ≈ ${assumed} g，请确认`
    }
  }

  return {
    qty: parsed.qty,
    unit: parsed.unit,
    basis: 'unknown',
    note: `「${parsed.unit}」没有可用克重，请补充「${parsed.qty}${parsed.unit}约等于多少克」`
  }
}

/** 生成给用户 / 导出用的份量说明。 */
export function describePortion(portion: ResolvedPortion): string {
  const head = `${portion.qty}${portion.unit}`
  if (portion.grams === undefined) return `${head}（克重未知）`
  if (portion.basis === 'mass') return head
  if (portion.basis === 'explicit') return `${head}(${portion.grams}g)`
  return `${head}（约 ${portion.grams} g）`
}
