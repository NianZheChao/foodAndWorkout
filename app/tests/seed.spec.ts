import { describe, expect, it } from 'vitest'
import { foodSeed, FOOD_SEED_VERSION } from '@/data/seed'
import { isAlcoholic, normalizeFoodName } from '@/domain/foodName'

describe('内置食物种子库', () => {
  it('由工作区 foods.csv 生成且非空', () => {
    expect(FOOD_SEED_VERSION).toMatch(/^foods\.csv@\d{4}-\d{2}-\d{2}$/)
    expect(foodSeed.length).toBeGreaterThan(100)
  })

  it('名称唯一（归一化后也不重复）', () => {
    const names = foodSeed.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
    const norms = foodSeed.map((f) => normalizeFoodName(f.name))
    expect(new Set(norms).size).toBe(norms.length)
  })

  it('六项数值都是有限非负数', () => {
    for (const food of foodSeed) {
      for (const key of ['kcal', 'proteinG', 'fatG', 'carbG', 'fiberG', 'sodiumMg'] as const) {
        const value = food[key]
        expect(Number.isFinite(value), `${food.name}.${key}`).toBe(true)
        expect(value, `${food.name}.${key}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('每条都有计量基准；非 100g/100ml 的条目必须写明依据', () => {
    for (const food of foodSeed) {
      expect(food.unit, food.name).toBeTruthy()
      if (food.unit !== '100g' && food.unit !== '100ml') {
        expect(food.note, `${food.name} 缺少数值依据`).toBeTruthy()
      }
    }
  })

  it('热量与宏量大致自洽（酒精豁免，容差同时看相对与绝对偏差）', () => {
    // 规则来源：docs/pwa-design.md §6.3。酒精的热量来自乙醇（7 kcal/g），
    // 不在宏量里，必须豁免；纤维与 Atwater 系数差异会带来几 kcal 的常量偏差，
    // 所以同时给一个绝对容差下限，避免把正常条目判为可疑。
    const outliers: string[] = []
    for (const food of foodSeed) {
      if (food.kcal <= 0 || isAlcoholic(food.name)) continue
      const macro = food.proteinG * 4 + food.fatG * 9 + food.carbG * 4
      const diff = Math.abs(macro - food.kcal)
      const tolerated = Math.max(food.kcal * 0.35, 25)
      if (diff > tolerated) outliers.push(`${food.name}(${macro.toFixed(1)} vs ${food.kcal})`)
    }
    expect(outliers, `宏量与热量偏差过大的条目：${outliers.join(', ')}`).toHaveLength(0)
  })
})