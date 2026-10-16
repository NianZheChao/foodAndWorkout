/**
 * 食物库治理（T4.4 / FR-406 / FR-411 / FR-412）。
 *
 * 页面需要的东西一次算好（条目 + 引用数 + 统计），避免在界面里散着查库：
 * 1. **来源筛选**（FR-411）与分类筛选是界面的事，这里只保证把 `source` / `disabledFlag` 原样给出去；
 * 2. **删除保护**（FR-412）是业务规则，必须落在这一层：被记录引用过的条目一律拒绝删除，
 *    界面把按钮禁掉只是顺手，绕不过这里；
 * 3. **手改数值**（FR-406 / DR-06）同样落在这一层：校验在 `domain/foodEdit.ts`，
 *    来源替换（改成「手工」并留痕）在这里，历史记录不受影响（DR-02）。
 *
 * FR-408（近似重复提醒）只剩**新增前提示合并**这一半，落在 `application/foodLibrary.ts` /
 * `foodResolve.ts`（写记录时问一句）。2026-10-16 下线了「疑似重复」静态分组卡片，理由是它的结论
 * 不可执行：真实的 114 条种子库里只有 5 组（鸡蛋 / 牛奶 / 肥牛卷 / 豆腐 / 啤酒），其中 4 组是
 * **设计上就该共存**的（全脂 vs 脱脂、生 vs 熟、南豆腐 vs 北豆腐），剩下那组「数值完全相同」的
 * 还是种子库有意留的（`鸡蛋(全蛋 生)` / `鸡蛋(水煮)`）。照它的建议「留一条、停用其余」，
 * 删掉的恰好是用户真正要的那条。真正需要拦的是「同一样东西被记了两遍」，那发生在新增那一刻。
 */

import { getFood, listFoods, removeFood, saveFood, setFoodDisabled } from '@/data/repositories/foods'
import { countIntakeByFood, tallyIntakeByFood } from '@/data/repositories/intake'
import { sameFacts } from '@/domain/nutrition'
import { applyFacts, reviewFactsEdit, type FoodFactsDraft } from '@/domain/foodEdit'
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

/**
 * 手改数值（FR-406 / DR-06）。
 *
 * 三条规则只在这里判，界面绕不过：
 * 1. 条目必须还在（用户可能一边开着列表一边把它删了）；
 * 2. 六项数值先过 `domain/foodEdit.ts` 的解析与校验：缺项 / 非数字 / 负数直接拒，
 *    越界与宏量不自洽只提醒（区间是给模型兜底的，用户手里的包装标签更可信）；
 * 3. **来源替换**：改成「手工」，并把原来的来源写进 `sourceNote` —— 这正是 DR-06 要的
 *    「用户实测 / 包装标签优先，且与模型估算区分标记」。
 *
 * 历史记录不受影响：摄入条目存的是当时的 `foodSnapshot`（DR-02），改基准值不会倒着改写已经记过的一餐。
 */
export async function editFoodFacts(id: string, draft: FoodFactsDraft, note = ''): Promise<FoodActionOutcome> {
  const food = await getFood(id)
  if (!food) return { ok: false, reason: '这条食物已经不在了（可能被删除或重新导入过）' }
  const review = reviewFactsEdit(food, draft)
  if (!review.ok || !review.facts) return { ok: false, reason: review.error ?? '这组数值没通过校验' }
  if (sameFacts(food, review.facts)) return { ok: false, reason: '六项数值和现在完全一样，没有要保存的改动' }
  await saveFood({
    ...applyFacts(food, review.facts),
    source: 'manual',
    sourceNote: manualSourceNote(food, note),
    // 置信度是模型估算才有的概念：数值换成用户实测之后它就该消失，否则界面与导出里会一直
    // 挂着一条过期的 low（FR-405 的置信度要求只针对模型生成的条目）。
    confidence: undefined
  })
  return { ok: true }
}

/**
 * 来源替换的留痕文案（DR-06）。
 *
 * 已经是手工条目就只更新备注，不再套一层「覆盖自」—— 否则改两次会变成
 * 「用户实测 · 覆盖自手工 · 覆盖自模型」，读起来像三份来源。
 */
export function manualSourceNote(food: Food, note: string): string {
  const base = note.trim() || '用户实测 / 包装标签'
  if (food.source === 'manual') return base
  const origin = food.sourceNote?.trim() ? `${SOURCE_LABELS[food.source]}：${food.sourceNote.trim()}` : SOURCE_LABELS[food.source]
  return `${base} · 覆盖自${origin}`
}