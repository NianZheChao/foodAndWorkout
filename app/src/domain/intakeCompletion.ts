/**
 * 待补全摄入条目的手工补齐（FR-506 的出口）。
 *
 * 一句话记录在「缺克数」或「缺食物数值」时会先落成 `pendingFlag = 1` 的占位条目。
 * 队列只能补模型能解析的食物，**缺克数的情况必须由用户给一个数**，所以这里提供同一套
 * 本地校验与换算：份量仍走 `resolvePortion`，营养值仍走 `factsForGrams`，绝不交给模型。
 */

import { emptyFactsDraft, reviewFactsEdit, type FoodFactsDraft } from './foodEdit'
import { NUTRIENT_KEYS, factsForGrams } from './nutrition'
import { resolvePortion } from './portion'
import type { Amount, Food, FoodSnapshot, IntakeEntry, NutritionFacts } from './types'

export interface IntakeCompletionInput {
  /** 从食物库选中的条目；不选就沿用记录里的快照 */
  food?: Food
  /** 份量写法，如 `120g` / `2只` / `一碗` */
  portionText: string
  /** 快照里没有可信数值时，用户手填的每 100 g 六项（字符串原样进来） */
  factsDraft?: FoodFactsDraft
}

export interface IntakeCompletionReview {
  ok: boolean
  error?: string
  /** 越界 / 宏量不自洽：只提示，不阻止保存（DR-06） */
  warnings: string[]
  /** 这条记录没有库内数值、需要用户补六项 */
  needsFacts: boolean
  /** `ok` 时才给出 */
  amount?: Amount
  foodId?: string
  foodSnapshot?: FoodSnapshot
  computed?: NutritionFacts
  /** 份量折算依据（按常见量估算时提示用户确认） */
  portionNote?: string
}

/** 快照里至少有一项非零，才认为它有可用的营养数值（占位快照是六项全 0）。 */
export function hasKnownNutrition(snapshot: Pick<FoodSnapshot, (typeof NUTRIENT_KEYS)[number]>): boolean {
  return NUTRIENT_KEYS.some((key) => snapshot[key] > 0)
}

function stubFoodOf(entry: IntakeEntry): Food {
  const snapshot = entry.foodSnapshot
  return {
    id: entry.foodId || snapshot.name,
    name: snapshot.name,
    nameNorm: snapshot.name,
    category: '',
    unit: snapshot.unit,
    basisGrams: snapshot.basisGrams,
    kcal: snapshot.kcal,
    proteinG: snapshot.proteinG,
    fatG: snapshot.fatG,
    carbG: snapshot.carbG,
    fiberG: snapshot.fiberG,
    sodiumMg: snapshot.sodiumMg,
    source: 'manual',
    createdAt: 0,
    updatedAt: 0
  }
}

function snapshotOf(food: Food): FoodSnapshot {
  return {
    name: food.name,
    unit: food.unit,
    basisGrams: food.basisGrams,
    kcal: food.kcal,
    proteinG: food.proteinG,
    fatG: food.fatG,
    carbG: food.carbG,
    fiberG: food.fiberG,
    sodiumMg: food.sodiumMg
  }
}

/** 把用户的输入折算成一条可落库的补丁；不写库，方便界面边填边预览。 */
export function reviewIntakeCompletion(
  entry: IntakeEntry,
  input: IntakeCompletionInput
): IntakeCompletionReview {
  const snapshot = entry.foodSnapshot
  const needsFacts = !input.food && !hasKnownNutrition(snapshot)
  let basis: Pick<Food, 'unit' | 'basisGrams' | 'portions'> & NutritionFacts
  let foodSnapshot = snapshot
  let foodId = entry.foodId
  const warnings: string[] = []

  if (input.food) {
    basis = input.food
    foodSnapshot = snapshotOf(input.food)
    foodId = input.food.id
  } else if (needsFacts) {
    const draft = input.factsDraft ?? emptyFactsDraft()
    const review = reviewFactsEdit(stubFoodOf(entry), draft)
    if (!review.ok || !review.facts) {
      return {
        ok: false,
        error: review.error ?? '这条记录还没有营养值，先把每 100 g 的六项填上',
        warnings: review.warnings,
        needsFacts
      }
    }
    warnings.push(...review.warnings)
    const manualUnit = snapshot.unit === '100ml' ? '100ml' : '100g'
    basis = { unit: manualUnit, ...review.facts }
    foodSnapshot = { name: snapshot.name, unit: manualUnit, ...review.facts }
  } else {
    basis = snapshot
  }

  const portion = resolvePortion(input.portionText, basis)
  if (portion.basis === 'unknown' || portion.grams === undefined || portion.grams <= 0) {
    return {
      ok: false,
      error: portion.note ?? '份量还没折算成克数，写 80g / 2个 / 一碗 这样的份量',
      warnings,
      needsFacts
    }
  }

  return {
    ok: true,
    warnings,
    needsFacts,
    amount: { qty: portion.qty, unit: portion.unit, grams: portion.grams },
    foodId,
    foodSnapshot,
    computed: factsForGrams(basis, portion.grams),
    portionNote: portion.note
  }
}
