/**
 * 食物库治理的本地判定（T4.4 / FR-408 / FR-412）。纯计算，不碰库。
 *
 * 这里只做两件事：**把疑似重复的条目聚成组**、**判断一组里的数值是不是完全一样**。
 * 刻意不做自动合并：括号里的限定语很可能正是区别本身（`牛奶(全脂 市售)` 与
 * `牛奶(脱脂 市售)` 归一化后同名，数值差一倍），自动挑一条留下就是静默改数值。
 * 所以按 FR-408 只「提醒」，删 / 停用由用户点（近似重复合并属 P2，见需求 §12 P2）。
 */

import { looseFoodKey } from './foodName'
import type { Food, NutritionFacts } from './types'

/** 六项数值是否完全一致。完全一致的一组基本可以确认是同一条重复条目。 */
export function sameFoodFacts(a: NutritionFacts, b: NutritionFacts): boolean {
  return (
    a.kcal === b.kcal &&
    a.proteinG === b.proteinG &&
    a.fatG === b.fatG &&
    a.carbG === b.carbG &&
    a.fiberG === b.fiberG &&
    a.sodiumMg === b.sodiumMg
  )
}

export interface SuspectedDuplicateGroup {
  /** 组内的宽松键（去括号后归一化），只用于 `:key` 与去重 */
  key: string
  foods: Food[]
  /** 组内数值完全一致：基本可以确认是同一条重复条目 */
  identicalFacts: boolean
}

/**
 * 按「去括号后的主名」分组，只留下 ≥2 条的组。
 *
 * 组内按名称排序、组间按首条名称排序，保证同一份库每次渲染顺序一致。
 */
export function groupSuspectedDuplicates(foods: readonly Food[]): SuspectedDuplicateGroup[] {
  const buckets = new Map<string, Food[]>()
  for (const food of foods) {
    const key = looseFoodKey(food.name)
    if (!key) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(food)
    else buckets.set(key, [food])
  }
  const collator = new Intl.Collator('zh-Hans-CN')
  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([key, bucket]) => ({
      key,
      foods: [...bucket].sort((a, b) => collator.compare(a.name, b.name)),
      identicalFacts: bucket.every((food) => sameFoodFacts(food, bucket[0]))
    }))
    .sort((a, b) => collator.compare(a.foods[0].name, b.foods[0].name))
}
