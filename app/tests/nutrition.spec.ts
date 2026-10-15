import { describe, expect, it } from 'vitest'
import {
  basisGramsOf,
  emptyFacts,
  factsForGrams,
  isMacroConsistent,
  macroKcal,
  roundFacts,
  scaleFacts,
  sumFacts
} from '@/domain/nutrition'
import { foodSeed } from '@/data/seed'

const egg = {
  unit: '100g',
  kcal: 144,
  proteinG: 13.3,
  fatG: 8.8,
  carbG: 2.8,
  fiberG: 0,
  sodiumMg: 131
}

describe('营养换算', () => {
  it('按克数等比缩放（基准 100 g）', () => {
    const half = factsForGrams(egg, 50)
    expect(half.kcal).toBeCloseTo(72, 6)
    expect(half.proteinG).toBeCloseTo(6.65, 6)
    expect(half.sodiumMg).toBeCloseTo(65.5, 6)
  })

  it('非 100 g 基准按 basisGrams 折算', () => {
    const croissant = { ...egg, unit: '个', basisGrams: 80 }
    expect(basisGramsOf(croissant)).toBe(80)
    expect(factsForGrams(croissant, 160).kcal).toBeCloseTo(288, 6)
  })

  it('克数非法时返回空值，不抛错也不给假数据', () => {
    expect(factsForGrams(egg, Number.NaN)).toEqual(emptyFacts())
  })

  it('求和与整体缩放', () => {
    const total = sumFacts([factsForGrams(egg, 100), factsForGrams(egg, 100)])
    expect(total.kcal).toBeCloseTo(288, 6)
    expect(scaleFacts(egg, 0.5).kcal).toBeCloseTo(72, 6)
  })

  it('四舍五入只用于显示，默认 1 位小数', () => {
    expect(roundFacts({ ...emptyFacts(), kcal: 550.55, proteinG: 30.14 })).toMatchObject({
      kcal: 550.6,
      proteinG: 30.1
    })
  })
})

describe('宏量与热量自洽（DR：双阈值 + 酒精豁免）', () => {
  it('芦笋这类纤维占比高的条目不该误报', () => {
    // 数据取自内置种子库（data/foods.csv 的「芦笋」）：
    // 纤维约 4 kcal/g 但不计入宏量，只卡相对偏差会误报
    const asparagus = foodSeed.find((food) => food.name === '芦笋')
    if (!asparagus) throw new Error('种子库里没有芦笋')
    expect(macroKcal(asparagus)).toBeCloseTo(26.1, 6)
    expect(isMacroConsistent(asparagus)).toBe(true)
  })

  it('明显不自洽的条目会被识别', () => {
    expect(isMacroConsistent({ kcal: 500, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 })).toBe(
      false
    )
  })

  it('酒精饮品豁免（乙醇热量不进宏量）', () => {
    const beer = { kcal: 43, proteinG: 0.5, fatG: 0, carbG: 3.6, fiberG: 0, sodiumMg: 4 }
    expect(isMacroConsistent(beer)).toBe(false)
    expect(isMacroConsistent(beer, { alcoholic: true })).toBe(true)
  })
})
