import { db } from '../db'
import { toPlain } from '../plain'
import { normalizeFoodName } from '@/domain/foodName'
import type { Food, FoodSource, FoodUnit } from '@/domain/types'

export interface SeedFood {
  name: string
  category: string
  /** 计量基准；非 100g/100ml 时必须在 note 里写清依据 */
  unit: FoodUnit
  kcal: number
  proteinG: number
  fatG: number
  carbG: number
  fiberG: number
  sodiumMg: number
  /** 单基准单位对应的克数（按件且克重未知时留空） */
  basisGrams?: number
  note?: string
}

export async function countFoods(): Promise<number> {
  return db.foods.count()
}

export async function listFoods(options: { includeDisabled?: boolean } = {}): Promise<Food[]> {
  const all = await db.foods.toArray()
  const filtered = options.includeDisabled ? all : all.filter((f) => f.disabledFlag !== 1)
  return filtered.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function searchFoods(query: string, limit = 20): Promise<Food[]> {
  const q = normalizeFoodName(query)
  if (!q) return (await listFoods()).slice(0, limit)
  const all = await listFoods()
  return all
    .filter((f) => f.nameNorm.includes(q) || f.name.includes(query))
    .slice(0, limit)
}

export async function findByNormalizedName(name: string): Promise<Food | undefined> {
  const norm = normalizeFoodName(name)
  const hits = await db.foods.where('nameNorm').equals(norm).toArray()
  return hits.find((f) => f.disabledFlag !== 1) ?? hits[0]
}

/**
 * 停用 / 恢复（FR-412）。
 *
 * 停用只让条目**不再出现在检索与新增候选里**（`listFoods` / `searchFoods` 会过滤掉它），
 * 历史记录不受影响 —— 摄入条目存的是 `foodSnapshot` 快照，本来就不会随食物库变形（DR-02）。
 */
export async function setFoodDisabled(id: string, disabled: boolean): Promise<void> {
  await db.foods.update(id, toPlain({ disabledFlag: disabled ? 1 : 0, updatedAt: Date.now() }))
}

/**
 * 物理删除。**调用方必须先确认没有记录引用过它**（FR-412）：
 * 那条业务规则在 `application/foodAdmin.ts` 里守着，仓储只负责删。
 */
export async function removeFood(id: string): Promise<void> {
  await db.foods.delete(id)
}

export async function getFood(id: string): Promise<Food | undefined> {
  return db.foods.get(id)
}

/**
 * 覆盖一条食物（FR-406 的手改数值走这里）。校验与来源替换在 `application/foodAdmin.ts` 里做完，
 * 到这里就是一条已经拍平的完整记录：同 id 覆盖，`updatedAt` 由仓储统一刷新。
 */
export async function saveFood(food: Food): Promise<void> {
  await db.foods.put(toPlain({ ...food, updatedAt: Date.now() }))
}

export interface UpsertFoodInput extends SeedFood {
  source: FoodSource
  sourceNote?: string
  confidence?: Food['confidence']
  cookedState?: Food['cookedState']
  portions?: Food['portions']
}

/** 新增或更新一条食物条目；同名（归一化后）存在时更新之，避免库膨胀（FR-408）。 */
export async function upsertFood(input: UpsertFoodInput): Promise<Food> {
  const existing = await findByNormalizedName(input.name)
  const now = Date.now()
  const food: Food = {
    id: existing?.id ?? input.name,
    name: input.name,
    nameNorm: normalizeFoodName(input.name),
    category: input.category,
    unit: input.unit,
    basisGrams: input.basisGrams ?? existing?.basisGrams,
    kcal: input.kcal,
    proteinG: input.proteinG,
    fatG: input.fatG,
    carbG: input.carbG,
    fiberG: input.fiberG,
    sodiumMg: input.sodiumMg,
    edibleNote: input.note ?? existing?.edibleNote,
    cookedState: input.cookedState ?? existing?.cookedState,
    portions: input.portions ?? existing?.portions,
    source: existing?.source === 'manual' ? 'manual' : input.source,
    sourceNote: input.sourceNote ?? existing?.sourceNote,
    confidence: input.confidence ?? existing?.confidence,
    disabledFlag: existing?.disabledFlag,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  await db.foods.put(toPlain(food))
  return food
}

/** 把内置种子库写入 IndexedDB；幂等：已存在的条目只补不覆盖用户改动。 */
export async function seedFoods(seed: SeedFood[], seedVersion: string): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0
  let skipped = 0
  const now = Date.now()
  await db.transaction('rw', db.foods, async () => {
    for (const item of seed) {
      const existing = await findByNormalizedName(item.name)
      if (existing) {
        skipped += 1
        continue
      }
      await db.foods.put(
        toPlain({
          id: item.name,
          name: item.name,
          nameNorm: normalizeFoodName(item.name),
          category: item.category,
          unit: item.unit,
          kcal: item.kcal,
          proteinG: item.proteinG,
          fatG: item.fatG,
          carbG: item.carbG,
          fiberG: item.fiberG,
          sodiumMg: item.sodiumMg,
          basisGrams: item.basisGrams,
          edibleNote: item.note,
          source: 'seed',
          sourceNote: seedVersion,
          createdAt: now,
          updatedAt: now
        })
      )
      inserted += 1
    }
  })
  return { inserted, skipped }
}
