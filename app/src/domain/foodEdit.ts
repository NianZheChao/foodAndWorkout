/**
 * 编辑食物数值（FR-406 / DR-06）。纯计算：解析界面输入 → 校验 → 给出「改完之后」的条目。
 *
 * 三点口径：
 * 1. **六项都要填**：漏填一律报错，不拿 0 当「没填」—— 0 kcal 与「不知道」是两件事（DR-04）；
 * 2. **越界只提醒不拦截**：区间是给模型兜底的（`domain/nutrientRange.ts`），用户手里有包装标签时
 *    以他为准（DR-06）；界面把 `warnings` 显出来让他自己确认就行；
 * 3. **只换数值**：`source` / `sourceNote` 的来源替换属业务规则，在 `application/foodAdmin.ts` 里做。
 */

import { isAlcoholic } from './foodName'
import { NUTRIENT_KEYS, NUTRIENT_LABELS, isMacroConsistent, macroKcal, type NutrientKey } from './nutrition'
import { rangeChecks } from './nutrientRange'
import type { Food, NutritionFacts } from './types'

/** 界面上的六项输入：字符串原样进来，解析在这里做（`type="number"` 也会给字符串）。 */
export type FoodFactsDraft = Record<NutrientKey, string>

export function emptyFactsDraft(): FoodFactsDraft {
  return { kcal: '', proteinG: '', fatG: '', carbG: '', fiberG: '', sodiumMg: '' }
}

/** 打开编辑器时的初值：条目的现值原样填进去，方便在原有基础上改。 */
export function draftOfFood(food: Food): FoodFactsDraft {
  return {
    kcal: String(food.kcal),
    proteinG: String(food.proteinG),
    fatG: String(food.fatG),
    carbG: String(food.carbG),
    fiberG: String(food.fiberG),
    sodiumMg: String(food.sodiumMg)
  }
}

export interface FoodEditReview {
  /** 六项是否都解析成功。false 时界面应禁用「保存」并显示 `error`。 */
  ok: boolean
  error?: string
  facts?: NutritionFacts
  /** 越界 / 宏量不自洽：**只提示，不阻塞保存** */
  warnings: string[]
}

/** 解析 + 校验一份草稿，给出可以落库的六项数值（或一条说明为什么不行的原因）。 */
export function reviewFactsEdit(food: Food, draft: FoodFactsDraft): FoodEditReview {
  const facts = {} as NutritionFacts
  for (const key of NUTRIENT_KEYS) {
    const raw = draft[key]?.trim() ?? ''
    if (!raw) {
      return {
        ok: false,
        error: `${NUTRIENT_LABELS[key]}没填。六项都要填：现场不知道就先去包装标签或厨房秤上找，别用 0 顶替。`,
        warnings: []
      }
    }
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      return { ok: false, error: `${NUTRIENT_LABELS[key]}的「${raw}」不是数字。`, warnings: [] }
    }
    if (value < 0) {
      return { ok: false, error: `${NUTRIENT_LABELS[key]}不能是负数。`, warnings: [] }
    }
    facts[key] = value
  }

  const warnings = [...rangeChecks(facts)]
  if (!isMacroConsistent(facts, { alcoholic: isAlcoholic(food.name) })) {
    const derived = Math.round(macroKcal(facts))
    warnings.push(`宏量折算约 ${derived} kcal，与标注的 ${Math.round(facts.kcal)} kcal 差得较多，请确认`)
  }
  return { ok: true, facts, warnings }
}

/**
 * 把新数值写进条目。**只动六项**：名称 / 分类 / 基准 / 停用标记 / 创建时间都保持原样 ——
 * 用户改的是「这条食物每 100g 是多少」，不是「这是哪条食物」。
 */
export function applyFacts(food: Food, facts: NutritionFacts, now = Date.now()): Food {
  return { ...food, ...facts, updatedAt: now }
}