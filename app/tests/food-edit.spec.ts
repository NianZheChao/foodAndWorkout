// @vitest-environment node
/**
 * 手改食物数值（FR-406 / DR-06）。
 *
 * 守四件事：**六项缺一不可**（0 与「没填」是两件事，DR-04）、**越界只提醒不拦**（用户手里的
 * 包装标签比任何区间都可信）、**来源替换要留痕**（改成「手工」并写清覆盖自哪里）、
 * **历史记录不动**（摄入条目存的是当时的快照，DR-02）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/data/db'
import { editFoodFacts, manualSourceNote } from '@/application/foodAdmin'
import { getFood, listFoods, upsertFood, type UpsertFoodInput } from '@/data/repositories/foods'
import { toPlain } from '@/data/plain'
import { draftOfFood, reviewFactsEdit, type FoodFactsDraft } from '@/domain/foodEdit'
import type { Food, FoodSource, IntakeEntry } from '@/domain/types'

const EGG = '鸡蛋(全蛋 生)'

function foodInput(name: string, source: FoodSource, patch: Partial<UpsertFoodInput> = {}): UpsertFoodInput {
  return {
    name,
    category: '蛋奶',
    unit: '100g',
    kcal: 144,
    proteinG: 13.3,
    fatG: 8.8,
    carbG: 2.8,
    fiberG: 0,
    sodiumMg: 131,
    source,
    ...patch
  }
}

function draftOf(patch: Partial<FoodFactsDraft>): FoodFactsDraft {
  return { kcal: '144', proteinG: '13.3', fatG: '8.8', carbG: '2.8', fiberG: '0', sodiumMg: '131', ...patch }
}

function intakeOf(foodId: string, id = 'in_1'): IntakeEntry {
  return {
    id,
    date: '2026-10-15',
    meal: '午餐',
    dish: '测试餐',
    foodId,
    foodSnapshot: { name: foodId, unit: '100g', kcal: 95, proteinG: 7, fatG: 6, carbG: 2, fiberG: 0, sodiumMg: 80 },
    amount: { qty: 50, unit: 'g', grams: 50 },
    computed: { kcal: 47.5, proteinG: 3.5, fatG: 3, carbG: 1, fiberG: 0, sodiumMg: 40 }
  }
}

async function llmEgg(): Promise<Food> {
  return upsertFood(
    foodInput(EGG, 'llm', { kcal: 95, proteinG: 7, fatG: 6, carbG: 2, sodiumMg: 80, sourceNote: '模型解析', confidence: 'low' })
  )
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('编辑草稿的解析与校验（FR-406）', () => {
  it('打开编辑器时用现值当初值', async () => {
    const egg = await llmEgg()
    expect(draftOfFood(egg)).toEqual({
      kcal: '95',
      proteinG: '7',
      fatG: '6',
      carbG: '2',
      fiberG: '0',
      sodiumMg: '80'
    })
  })

  it('六项缺一不可：空着不当作 0，直接指出缺哪项', async () => {
    const egg = await llmEgg()
    const review = reviewFactsEdit(egg, draftOf({ sodiumMg: '  ' }))
    expect(review.ok).toBe(false)
    expect(review.facts).toBeUndefined()
    expect(review.error).toContain('钠没填')
  })

  it('非数字与负数一律拒绝', async () => {
    const egg = await llmEgg()
    expect(reviewFactsEdit(egg, draftOf({ proteinG: '七' })).error).toContain('不是数字')
    expect(reviewFactsEdit(egg, draftOf({ fatG: '-1' })).error).toContain('不能是负数')
  })


  it('超出区间只给提醒，仍然可以保存', async () => {
    const egg = await llmEgg()
    const over = reviewFactsEdit(egg, draftOf({ sodiumMg: '9000' }))
    expect(over.ok).toBe(true)
    expect(over.warnings.join()).toContain('钠 9000 超出')
    expect(over.facts?.sodiumMg).toBe(9000)

    // 宏量折算 13.3*4 + 8.8*9 + 2.8*4 = 143.2 kcal，与 700 kcal 差得很远
    const inconsistent = reviewFactsEdit(egg, draftOf({ kcal: '700' }))
    expect(inconsistent.ok).toBe(true)
    expect(inconsistent.warnings.join()).toContain('宏量折算')
  })
})

describe('来源替换与落库（FR-406 / DR-06）', () => {
  it('把模型条目改成手工：来源变、留痕变、置信度消失，名称与基准不动', async () => {
    await llmEgg()
    const outcome = await editFoodFacts(EGG, draftOf({ kcal: '155', proteinG: '12.6' }), '包装标签')
    expect(outcome).toEqual({ ok: true })

    const updated = (await getFood(EGG)) as Food
    expect(updated.kcal).toBe(155)
    expect(updated.proteinG).toBe(12.6)
    expect(updated.source).toBe('manual')
    expect(updated.sourceNote).toBe('包装标签 · 覆盖自模型：模型解析')
    expect(updated.confidence).toBeUndefined()
    expect(updated.name).toBe(EGG)
    expect(updated.category).toBe('蛋奶')
    expect(updated.unit).toBe('100g')
    expect(updated.nameNorm).toBe((await getFood(EGG))?.nameNorm)
  })

  it('没写来源说明时用默认文案；已经是手工条目就不再套一层「覆盖自」', async () => {
    await llmEgg()
    await editFoodFacts(EGG, draftOf({ kcal: '155' }))
    expect((await getFood(EGG))?.sourceNote).toBe('用户实测 / 包装标签 · 覆盖自模型：模型解析')

    await editFoodFacts(EGG, draftOf({ kcal: '160' }), '厨房秤')
    expect((await getFood(EGG))?.sourceNote).toBe('厨房秤')

    const manual = await upsertFood(foodInput('自制酸奶', 'manual', { sourceNote: '自家配方' }))
    expect(manualSourceNote(manual, '')).toBe('用户实测 / 包装标签')
    expect(manualSourceNote(manual, ' 包装 ')).toBe('包装')
  })

  it('数值一模一样时不写库，并说清原因', async () => {
    const egg = await llmEgg()
    const outcome = await editFoodFacts(EGG, draftOfFood(egg))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('完全一样')
    expect((await getFood(EGG))?.source).toBe('llm')
  })

  it('条目已经不在时拒绝，不凭空造一条出来', async () => {
    const outcome = await editFoodFacts('不存在的食物', draftOf({}))
    expect(outcome.ok).toBe(false)
    expect(await listFoods({ includeDisabled: true })).toHaveLength(0)
  })

  it('改基准值不倒着改写已记录的那一餐（DR-02）', async () => {
    await llmEgg()
    await db.intake.put(toPlain(intakeOf(EGG)))
    await editFoodFacts(EGG, draftOf({ kcal: '155' }))

    const entry = (await db.intake.get('in_1')) as IntakeEntry
    expect(entry.foodSnapshot.kcal).toBe(95)
    expect(entry.computed.kcal).toBeCloseTo(47.5, 5)
  })
})