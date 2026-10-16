/**
 * 六项营养数值的合理区间（`docs/pwa-design.md` §6.3 / FR-407）。**全应用只有这一份定义。**
 *
 * 模型解析出来的数值（`application/foodResolve.ts`）与用户手改的数值（`domain/foodEdit.ts`）
 * 都拿它判「可疑」。两边各写一套就会出现两套标准：模型填 6000 mg 钠要确认、用户手填 6000 却放行。
 *
 * 区间按**每个基准单位**（一般 100 g / 100 ml）给。越界只提示、不阻塞 —— 手里有包装标签的人
 * 比任何区间都可信（DR-06）。
 */

import { NUTRIENT_LABELS, type NutrientKey } from './nutrition'
import type { NutritionFacts } from './types'

export const NUTRIENT_RANGES: Record<NutrientKey, readonly [number, number]> = {
  kcal: [0, 900],
  proteinG: [0, 100],
  fatG: [0, 100],
  carbG: [0, 100],
  fiberG: [0, 100],
  sodiumMg: [0, 5000]
}

/** 越界项的中文说明；空数组表示六项都落在区间内。 */
export function rangeChecks(facts: NutritionFacts): string[] {
  const messages: string[] = []
  for (const key of Object.keys(NUTRIENT_RANGES) as NutrientKey[]) {
    const [min, max] = NUTRIENT_RANGES[key]
    const value = facts[key]
    if (!Number.isFinite(value) || value < min || value > max) {
      messages.push(`${NUTRIENT_LABELS[key]} ${value} 超出每 100g/ml 的合理范围（${min}–${max}），请确认`)
    }
  }
  return messages
}