/**
 * 待补全摄入条目的手工补齐：份量与数值都在本地校验 / 换算，不经过模型。
 */

import { describe, expect, it } from 'vitest'
import { hasKnownNutrition, reviewIntakeCompletion } from '@/domain/intakeCompletion'
import { emptyFactsDraft, type FoodFactsDraft } from '@/domain/foodEdit'
import type { Food, IntakeEntry } from '@/domain/types'

function entry(patch: Partial<IntakeEntry> = {}): IntakeEntry {
  return {
    id: 'in_test',
    date: '2026-10-19',
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食物',
    foodSnapshot: {
      name: '测试食物',
      unit: '100g',
      kcal: 150,
      proteinG: 10,
      fatG: 5,
      carbG: 15,
      fiberG: 2,
      sodiumMg: 300
    },
    amount: { qty: 1, unit: '待补全' },
    computed: { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 },
    pendingFlag: 1,
    ...patch
  }
}

function factsDraft(patch: Partial<FoodFactsDraft> = {}): FoodFactsDraft {
  return {
    ...emptyFactsDraft(),
    kcal: '200',
    proteinG: '20',
    fatG: '5',
    carbG: '10',
    fiberG: '2',
    sodiumMg: '100',
    ...patch
  }
}

describe('待补全记录的手工补齐', () => {
  it('快照里已有数值时，只要补份量并按克数重算', () => {
    const review = reviewIntakeCompletion(entry(), { portionText: '120g' })
    expect(review.ok).toBe(true)
    expect(review.needsFacts).toBe(false)
    expect(review.amount).toMatchObject({ qty: 120, unit: 'g', grams: 120 })
    expect(review.computed?.kcal).toBeCloseTo(180, 5)
    expect(review.computed?.proteinG).toBeCloseTo(12, 5)
  })

  it('占位快照没有营养值时，要求先补每 100g 的六项', () => {
    const placeholder = entry({
      foodSnapshot: {
        name: '凯撒沙拉',
        unit: '100g',
        kcal: 0,
        proteinG: 0,
        fatG: 0,
        carbG: 0,
        fiberG: 0,
        sodiumMg: 0
      }
    })
    expect(hasKnownNutrition(placeholder.foodSnapshot)).toBe(false)
    const review = reviewIntakeCompletion(placeholder, { portionText: '100g' })
    expect(review.ok).toBe(false)
    expect(review.needsFacts).toBe(true)
    expect(review.error).toContain('热量没填')
  })

  it('手填六项后按 100g 口径换算，并替换占位快照', () => {
    const placeholder = entry({
      foodSnapshot: {
        name: '凯撒沙拉',
        unit: '100g',
        kcal: 0,
        proteinG: 0,
        fatG: 0,
        carbG: 0,
        fiberG: 0,
        sodiumMg: 0
      }
    })
    const review = reviewIntakeCompletion(placeholder, {
      portionText: '150g',
      factsDraft: factsDraft()
    })
    expect(review.ok).toBe(true)
    expect(review.needsFacts).toBe(true)
    expect(review.amount?.grams).toBe(150)
    expect(review.computed?.kcal).toBeCloseTo(300, 5)
    expect(review.foodSnapshot).toMatchObject({ name: '凯撒沙拉', unit: '100g', kcal: 200 })
  })

  it('选中食物库条目后，用库里的数值与份量基准换算', () => {
    const food: Food = {
      id: '鸡蛋(全蛋 生)',
      name: '鸡蛋(全蛋 生)',
      nameNorm: '鸡蛋(全蛋 生)',
      category: '蛋奶',
      unit: '个',
      basisGrams: 50,
      kcal: 72,
      proteinG: 6.3,
      fatG: 4.8,
      carbG: 0.4,
      fiberG: 0,
      sodiumMg: 65,
      source: 'seed',
      createdAt: 0,
      updatedAt: 0
    }
    const review = reviewIntakeCompletion(entry(), { food, portionText: '2个' })
    expect(review.ok).toBe(true)
    expect(review.foodId).toBe(food.id)
    expect(review.amount?.grams).toBe(100)
    expect(review.computed?.kcal).toBeCloseTo(144, 5)
    expect(review.foodSnapshot?.name).toBe(food.name)
  })

  it('份量折算不出来时不落库，并给出可操作的提示', () => {
    const review = reviewIntakeCompletion(entry(), { portionText: '一点点' })
    expect(review.ok).toBe(false)
    expect(review.error).toContain('无法识别份量')
  })
})
