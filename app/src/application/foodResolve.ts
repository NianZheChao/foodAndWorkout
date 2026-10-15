/**
 * `food.resolve` 的应用层（FR-403 / FR-404 / FR-1408）。
 *
 * 顺序是「本地优先」：库里已有（含别名）的条目直接返回，不进入请求；
 * 只有真正没有的才批量问模型，且一次不超过 10 条（DR-41）。
 * 模型给的结果不直接落库——先过范围与宏量自洽校验，可疑项标出来让用户确认（FR-407）。
 */

import { isAlcoholic, normalizeFoodName } from '@/domain/foodName'
import { isMacroConsistent } from '@/domain/nutrition'
import { findByNormalizedName, listFoods, upsertFood } from '@/data/repositories/foods'
import { enqueue, markOp } from '@/data/repositories/pendingOps'
import { runTask, type RunFailure, type RunOptions } from '@/llm'
import { foodResolveTask, type ResolvedFoodItem } from '@/llm/tasks/foodResolve'
import { baseNameOf, findFoodFuzzy } from './foodLibrary'
import type { Confidence, Food, NutritionFacts } from '@/domain/types'

/** 一次请求最多合并多少条未知食物（超出分批，§6.3）。 */
export const FOOD_BATCH_LIMIT = 10

/** 每 100g/ml 的合理范围（§6.3）。越界只标记可疑，不直接丢弃。 */
export const NUTRIENT_RANGES: Record<keyof NutritionFacts, readonly [number, number]> = {
  kcal: [0, 900],
  proteinG: [0, 100],
  fatG: [0, 100],
  carbG: [0, 100],
  fiberG: [0, 100],
  sodiumMg: [0, 5000]
}

export interface FoodResolveCandidate {
  query: string
  matched: boolean
  /** 命中本地库，未消耗任何 token */
  fromCache: boolean
  /** 业务校验的疑点，非空时需用户确认后才参与汇总 */
  suspicious: string[]
  needsConfirm: boolean
  message?: string
  /** 归一化后的食物（尚未落库） */
  food?: Food
  /** 库里已有条目：提示合并而不是新增（FR-408） */
  existing?: Food
  existingKind?: 'exact' | 'contains'
}

export interface ResolveFoodsOutcome {
  candidates: FoodResolveCandidate[]
  failure?: Pick<RunFailure, 'kind' | 'message' | 'retriable'>
  /** 已写入待办队列的查询（无网 / 未配模型时在这里等） */
  queued: string[]
}

export interface ResolveBehavior {
  /**
   * 失败时是否写待办队列，默认写（记录链路的第一次尝试）。
   * 队列重放时必须传 `false`：否则每次重放失败都会再排一条，队列越滚越长（§6.10）。
   */
  enqueueOnFailure?: boolean
}

function rangeChecks(facts: NutritionFacts): string[] {
  const messages: string[] = []
  const labels: Record<keyof NutritionFacts, string> = {
    kcal: '热量',
    proteinG: '蛋白',
    fatG: '脂肪',
    carbG: '碳水',
    fiberG: '纤维',
    sodiumMg: '钠'
  }
  for (const key of Object.keys(NUTRIENT_RANGES) as (keyof NutritionFacts)[]) {
    const [min, max] = NUTRIENT_RANGES[key]
    const value = facts[key]
    if (!Number.isFinite(value) || value < min || value > max) {
      messages.push(`${labels[key]} ${value} 超出每 100g/ml 的合理范围（${min}–${max}），请确认`)
    }
  }
  return messages
}

function toFacts(item: ResolvedFoodItem): NutritionFacts {
  return {
    kcal: item.kcal ?? 0,
    proteinG: item.protein_g ?? 0,
    fatG: item.fat_g ?? 0,
    carbG: item.carb_g ?? 0,
    fiberG: item.fiber_g ?? 0,
    sodiumMg: item.sodium_mg ?? 0
  }
}

function basisGramsOfUnit(unit: string, portions: Food['portions']): number | undefined {
  if (/^100\s*(g|ml|克|毫升)$/i.test(unit)) return undefined
  return portions?.length === 1 ? portions[0].grams : undefined
}

export function toFood(item: ResolvedFoodItem, now = Date.now()): Food {
  const name = item.name?.trim() ?? ''
  const unit = item.unit?.trim() || '100g'
  return {
    id: name,
    name,
    nameNorm: normalizeFoodName(name),
    category: item.category?.trim() || '其他',
    unit,
    basisGrams: basisGramsOfUnit(unit, item.portions),
    ...toFacts(item),
    edibleNote: item.edible_note,
    cookedState: item.cooked_state,
    portions: item.portions,
    source: 'llm',
    sourceNote: item.source_note ?? '模型解析',
    confidence: item.confidence as Confidence | undefined,
    createdAt: now,
    updatedAt: now
  }
}

function macroMessage(food: Food): string | undefined {
  if (isMacroConsistent(food, { alcoholic: isAlcoholic(food.name) })) return undefined
  const derived = food.proteinG * 4 + food.fatG * 9 + food.carbG * 4
  return `宏量折算约 ${Math.round(derived)} kcal，与标注的 ${Math.round(food.kcal)} kcal 差得较多，请确认`
}

/** 把模型返回的一条转成候选，并做范围 / 自洽 / 去重三类本地校验。 */
export async function buildCandidate(
  query: string,
  item: ResolvedFoodItem | undefined,
  now = Date.now()
): Promise<FoodResolveCandidate> {
  const base = { query, fromCache: false, suspicious: [] as string[], needsConfirm: false }
  if (!item || item.matched === false || !item.name?.trim()) {
    return { ...base, matched: false, needsConfirm: true, message: '模型无法确认这个食物，请手工录入营养值' }
  }

  const existing = await findByNormalizedName(item.name)
  if (existing) {
    return {
      ...base,
      matched: true,
      food: existing,
      existing,
      existingKind: 'exact',
      message: `库里已有「${existing.name}」，直接用库里的数值，不新增条目`
    }
  }

  const food = toFood(item, now)
  const suspicious = rangeChecks(food)
  const macro = macroMessage(food)
  if (macro) suspicious.push(macro)

  const all = await listFoods()
  const target = normalizeFoodName(baseNameOf(food.name))
  const approximate = all.find((row) => {
    const rowBase = normalizeFoodName(baseNameOf(row.name))
    return rowBase === target || rowBase.includes(target) || target.includes(rowBase)
  })

  return {
    ...base,
    matched: true,
    food,
    existing: approximate,
    existingKind: approximate ? 'contains' : undefined,
    suspicious,
    needsConfirm: suspicious.length > 0 || food.confidence === 'low',
    message: approximate ? `库里已有近似条目「${approximate.name}」，建议合并` : undefined
  }
}

/** 用户确认后才落库（FR-403）。 */
export async function persistCandidate(food: Food): Promise<Food> {
  return upsertFood({
    name: food.name,
    category: food.category,
    unit: food.unit,
    kcal: food.kcal,
    proteinG: food.proteinG,
    fatG: food.fatG,
    carbG: food.carbG,
    fiberG: food.fiberG,
    sodiumMg: food.sodiumMg,
    basisGrams: food.basisGrams,
    note: food.edibleNote,
    source: food.source,
    sourceNote: food.sourceNote,
    confidence: food.confidence,
    cookedState: food.cookedState,
    portions: food.portions
  })
}

async function queueFailures(queries: readonly string[], failure: RunFailure): Promise<string[]> {
  const waiting = failure.kind === 'not-configured' || failure.retriable
  const status = waiting ? 'waiting' : 'needs-attention'
  const queued: string[] = []
  for (const query of queries) {
    const id = await enqueue('food.resolve', query)
    await markOp(id, { status, lastError: failure.message })
    queued.push(query)
  }
  return queued
}

/**
 * 解析一批食物。命中库内的直接返回；未知的合并成一次请求。
 * 失败不抛异常：返回 `failure` 并把查询写入待办队列，调用方继续走手工录入（DR-44）。
 */
export async function resolveFoods(
  queries: readonly string[],
  options: RunOptions = {},
  behavior: ResolveBehavior = {}
): Promise<ResolveFoodsOutcome> {
  const unique = [...new Set(queries.map((query) => query.trim()).filter(Boolean))]
  const candidates: FoodResolveCandidate[] = []
  const unknown: string[] = []

  for (const query of unique) {
    const cached = await findFoodFuzzy(query)
    if (cached) {
      candidates.push({
        query,
        matched: true,
        fromCache: true,
        suspicious: [],
        needsConfirm: false,
        food: cached
      })
      continue
    }
    unknown.push(query)
  }

  if (!unknown.length) return { candidates, queued: [] }

  const batch = unknown.slice(0, FOOD_BATCH_LIMIT)
  const result = await runTask(foodResolveTask, { items: batch.map((text) => ({ text })) }, options)
  if (!result.ok) {
    return {
      candidates,
      failure: { kind: result.kind, message: result.message, retriable: result.retriable },
      queued: behavior.enqueueOnFailure === false ? [] : await queueFailures(batch, result)
    }
  }

  const byQuery = new Map<string, ResolvedFoodItem>()
  for (const item of result.value.items) byQuery.set(normalizeFoodName(item.query), item)

  for (const query of batch) {
    const item = byQuery.get(normalizeFoodName(query))
    candidates.push(await buildCandidate(query, item))
  }
  return { candidates, queued: [] }
}
