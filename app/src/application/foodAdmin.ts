/**
 * 食物库治理（T4.4 / FR-408 / FR-411 / FR-412）。
 *
 * 页面需要的东西一次算好（条目 + 引用数 + 疑似重复分组 + 统计），避免在界面里散着查库：
 * 1. **来源筛选**（FR-411）与分类筛选是界面的事，这里只保证把 `source` / `disabledFlag` 原样给出去；
 * 2. **疑似重复**（FR-408）交 `domain/foodAudit.ts` 分组，这里只负责喂数据；
 * 3. **删除保护**（FR-412）是业务规则，必须落在这一层：被记录引用过的条目一律拒绝删除，
 *    界面把按钮禁掉只是顺手，绕不过这里。
 */

import { listFoods, removeFood, setFoodDisabled } from '@/data/repositories/foods'
import { countIntakeByFood, tallyIntakeByFood } from '@/data/repositories/intake'
import { groupSuspectedDuplicates, type SuspectedDuplicateGroup } from '@/domain/foodAudit'
import type { Food, FoodSource } from '@/domain/types'

export const FOOD_SOURCES: readonly FoodSource[] = ['seed', 'llm', 'manual']

export const SOURCE_LABELS: Record<FoodSource, string> = {
  seed: '内置',
  llm: '模型',
  manual: '手工'
}

export interface FoodOverview {
  /** 全部条目，含已停用（停用的排在后面由界面决定怎么显示） */
  foods: Food[]
  duplicates: SuspectedDuplicateGroup[]
  /** `foodId` → 被多少条摄入记录引用过 */
  references: Map<string, number>
  stats: {
    total: number
    disabled: number
    /** 至少被一条记录引用过的条目数 */
    referenced: number
    bySource: Record<FoodSource, number>
  }
}

export async function buildFoodOverview(): Promise<FoodOverview> {
  const [foods, references] = await Promise.all([listFoods({ includeDisabled: true }), tallyIntakeByFood()])
  const bySource: Record<FoodSource, number> = { seed: 0, llm: 0, manual: 0 }
  for (const food of foods) bySource[food.source] += 1
  return {
    foods,
    duplicates: groupSuspectedDuplicates(foods),
    references,
    stats: {
      total: foods.length,
      disabled: foods.filter((food) => food.disabledFlag === 1).length,
      referenced: foods.filter((food) => (references.get(food.id) ?? 0) > 0).length,
      bySource
    }
  }
}

export type FoodActionOutcome = { ok: true } | { ok: false; reason: string }

/** 停用 / 恢复（FR-412）。停用不改数值，也不动历史记录。 */
export async function setDisabled(id: string, disabled: boolean): Promise<FoodActionOutcome> {
  const foods = await listFoods({ includeDisabled: true })
  if (!foods.some((food) => food.id === id)) return { ok: false, reason: '这条食物已经不在了（可能被删除或重新导入过）' }
  await setFoodDisabled(id, disabled)
  return { ok: true }
}

/**
 * 删除。被任何一条摄入记录引用过就拒绝（FR-412），只能停用。
 *
 * 这里再查一次引用数（而不是用 `buildFoodOverview` 拿到的快照）：从渲染列表到用户点确认之间，
 * 用户可能又记了一条，拿旧数据放行就会删掉正在被引用的条目。
 */
export async function deleteFood(id: string): Promise<FoodActionOutcome> {
  const references = await countIntakeByFood(id)
  if (references > 0) {
    return { ok: false, reason: `这条食物被 ${references} 条记录引用过，不能删除（FR-412）：请改用「停用」` }
  }
  await removeFood(id)
  return { ok: true }
}
