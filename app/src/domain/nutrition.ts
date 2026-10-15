/**
 * 营养计算：单条记录换算与当日求和。口径见 docs/pwa-design.md §5.2。
 *
 * 所有确定性计算都在本地完成，绝不交给模型（DR-45 / FR-1410）。
 */

import type { Food, FoodSnapshot, NutritionFacts } from '@/domain/types'

export const NUTRIENT_KEYS = ['kcal', 'proteinG', 'fatG', 'carbG', 'fiberG', 'sodiumMg'] as const
export type NutrientKey = (typeof NUTRIENT_KEYS)[number]

export const NUTRIENT_LABELS: Record<NutrientKey, string> = {
  kcal: '热量',
  proteinG: '蛋白质',
  fatG: '脂肪',
  carbG: '碳水',
  fiberG: '纤维',
  sodiumMg: '钠'
}

export const NUTRIENT_UNITS: Record<NutrientKey, string> = {
  kcal: 'kcal',
  proteinG: 'g',
  fatG: 'g',
  carbG: 'g',
  fiberG: 'g',
  sodiumMg: 'mg'
}

/** Atwater 系数，用于宏量与热量的自洽检查。 */
export const ATWATER = { proteinG: 4, fatG: 9, carbG: 4 } as const

export function emptyFacts(): NutritionFacts {
  return { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 }
}

/** 按系数整体缩放。 */
export function scaleFacts(facts: NutritionFacts, factor: number): NutritionFacts {
  return {
    kcal: facts.kcal * factor,
    proteinG: facts.proteinG * factor,
    fatG: facts.fatG * factor,
    carbG: facts.carbG * factor,
    fiberG: facts.fiberG * factor,
    sodiumMg: facts.sodiumMg * factor
  }
}

/** 食物条目的营养值表示「每基准单位」，默认基准是 100 g / 100 ml。 */
export function basisGramsOf(food: Pick<Food, 'unit' | 'basisGrams'>): number {
  if (food.basisGrams && food.basisGrams > 0) return food.basisGrams
  if (food.unit === '100g' || food.unit === '100ml') return 100
  return 100
}

/**
 * 按实际克数换算营养值。
 *
 * 基准优先级：条目自带的 basisGrams > 100 g/ml 约定。
 */
export function factsForGrams(
  food: Pick<Food, 'unit' | 'basisGrams'> & NutritionFacts,
  grams: number,
  basisGrams = basisGramsOf(food)
): NutritionFacts {
  if (!Number.isFinite(grams) || basisGrams <= 0) return emptyFacts()
  return scaleFacts(food, grams / basisGrams)
}

/** 由快照 + 克数换算（历史记录固定用快照，避免食物库改动污染旧数据）。 */
export function factsForSnapshot(snapshot: FoodSnapshot, grams: number): NutritionFacts {
  return factsForGrams(snapshot, grams)
}

export function sumFacts(list: readonly NutritionFacts[]): NutritionFacts {
  const total = emptyFacts()
  for (const item of list) {
    total.kcal += item.kcal
    total.proteinG += item.proteinG
    total.fatG += item.fatG
    total.carbG += item.carbG
    total.fiberG += item.fiberG
    total.sodiumMg += item.sodiumMg
  }
  return total
}

export function macroKcal(facts: Pick<NutritionFacts, 'proteinG' | 'fatG' | 'carbG'>): number {
  return facts.proteinG * ATWATER.proteinG + facts.fatG * ATWATER.fatG + facts.carbG * ATWATER.carbG
}

/**
 * 宏量与热量是否自洽（docs/pwa-design.md §6.3）。
 *
 * 同时看相对偏差 35% 与绝对偏差 25 kcal：纤维约 4 kcal/g 但不进宏量、
 * 四舍五入等都会带来几 kcal 的常量偏差，只卡相对值会误报。
 */
export function isMacroConsistent(
  facts: NutritionFacts,
  options: { alcoholic?: boolean } = {}
): boolean {
  if (options.alcoholic) return true
  if (facts.kcal <= 0) return true
  const diff = Math.abs(macroKcal(facts) - facts.kcal)
  return diff <= Math.max(facts.kcal * 0.35, 25)
}

/** 保留小数位（默认 1 位），用于显示与导出；存储层永远保留原始浮点。 */
export function roundFacts(facts: NutritionFacts, digits = 1): NutritionFacts {
  const factor = 10 ** digits
  const round = (value: number) => Math.round(value * factor) / factor
  return {
    kcal: round(facts.kcal),
    proteinG: round(facts.proteinG),
    fatG: round(facts.fatG),
    carbG: round(facts.carbG),
    fiberG: round(facts.fiberG),
    sodiumMg: round(facts.sodiumMg)
  }
}

