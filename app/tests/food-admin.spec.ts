// @vitest-environment node
/**
 * 食物库治理（T4.4 / FR-408 / FR-411 / FR-412）。
 *
 * 守四件事：**疑似重复只提醒不合并**（数值相同 / 不同要说清）、**停用后不再出现在检索里但历史记录
 * 不受影响**、**被记录引用过的条目删不掉**（业务规则在应用层，不只是界面把按钮禁掉）、
 * 统计口径（来源 / 停用 / 被引用）与库里一致。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/data/db'
import { buildFoodOverview, deleteFood, setDisabled, SOURCE_LABELS } from '@/application/foodAdmin'
import { listFoods, searchFoods, seedFoods, upsertFood, type UpsertFoodInput } from '@/data/repositories/foods'
import { addIntake, countIntakeByFood } from '@/data/repositories/intake'
import { groupSuspectedDuplicates, sameFoodFacts } from '@/domain/foodAudit'
import { baseNameOf, looseFoodKey } from '@/domain/foodName'
import { foodSeed, FOOD_SEED_VERSION } from '@/data/seed'
import type { Food, FoodSource, IntakeEntry } from '@/domain/types'

const EGG = '鸡蛋(全蛋 生)'
const BOILED_EGG = '鸡蛋(水煮)'
const WHOLE_MILK = '牛奶(全脂 市售)'
const SKIM_MILK = '牛奶(脱脂 市售)'
const CHICKEN = '鸡胸肉'

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

function intakeOf(foodId: string, id = 'in_1'): IntakeEntry {
  return {
    id,
    date: '2026-10-15',
    meal: '午餐',
    dish: '测试餐',
    foodId,
    foodSnapshot: { name: foodId, unit: '100g', kcal: 144, proteinG: 13.3, fatG: 8.8, carbG: 2.8, fiberG: 0, sodiumMg: 131 },
    amount: { qty: 100, unit: 'g', grams: 100 },
    computed: { kcal: 144, proteinG: 13.3, fatG: 8.8, carbG: 2.8, fiberG: 0, sodiumMg: 131 }
  }
}

/** 库里的合成样本：一组数值相同的重复、一组数值不同的同名、一条孤立条目。 */
async function seedLibrary(): Promise<void> {
  await upsertFood(foodInput(EGG, 'seed'))
  await upsertFood(foodInput(BOILED_EGG, 'seed'))
  await upsertFood(foodInput(WHOLE_MILK, 'llm', { category: '蛋奶', kcal: 65, proteinG: 3.3, fatG: 3.6, carbG: 4.9, sodiumMg: 60 }))
  await upsertFood(foodInput(SKIM_MILK, 'llm', { kcal: 35, proteinG: 3.4, fatG: 0.2, carbG: 5, sodiumMg: 60 }))
  await upsertFood(foodInput(CHICKEN, 'manual', { category: '肉禽', kcal: 133, proteinG: 24, fatG: 3, carbG: 1 }))
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('疑似重复分组（FR-408）', () => {
  it('去括号后同名归一组；数值完全一致与不一致要分开标', async () => {
    await seedLibrary()
    const groups = groupSuspectedDuplicates(await listFoods({ includeDisabled: true }))

    expect(groups.map((group) => group.key)).toEqual(['鸡蛋', '牛奶'])
    const [eggGroup, milkGroup] = groups
    expect(eggGroup.foods.map((food) => food.name).sort()).toEqual([BOILED_EGG, EGG].sort())
    expect(eggGroup.identicalFacts).toBe(true)
    expect(milkGroup.identicalFacts).toBe(false)
    // 孤立条目自己不成组
    expect(groups.flatMap((group) => group.foods.map((food) => food.name))).not.toContain(CHICKEN)
  })

  it('括号承载区别：宽松键故意丢掉括号，精确键保留', async () => {
    expect(looseFoodKey(WHOLE_MILK)).toBe(looseFoodKey(SKIM_MILK))
    expect(baseNameOf(WHOLE_MILK)).toBe('牛奶')
    expect(sameFoodFacts({ kcal: 1, proteinG: 2, fatG: 3, carbG: 4, fiberG: 5, sodiumMg: 6 }, { kcal: 1, proteinG: 2, fatG: 3, carbG: 4, fiberG: 5, sodiumMg: 6 })).toBe(true)
  })
})

describe('概况统计（FR-411）', () => {
  it('按来源 / 停用 / 被引用统计，引用次数与摄入记录一致', async () => {
    await seedLibrary()
    await addIntake(intakeOf(EGG))
    await addIntake(intakeOf(EGG, 'in_2'))
    await addIntake(intakeOf(CHICKEN, 'in_3'))
    await setDisabled(SKIM_MILK, true)

    const overview = await buildFoodOverview()
    expect(overview.stats).toEqual({
      total: 5,
      disabled: 1,
      referenced: 2,
      bySource: { seed: 2, llm: 2, manual: 1 }
    })
    expect(overview.references.get(EGG)).toBe(2)
    expect(overview.references.get(CHICKEN)).toBe(1)
    expect(overview.references.get(BOILED_EGG)).toBeUndefined()
    expect(Object.values(SOURCE_LABELS)).toEqual(['内置', '模型', '手工'])
  })

  it('种子库装进来也不炸（真实 114 条的口径）', async () => {
    await seedFoods(foodSeed, FOOD_SEED_VERSION)
    const overview = await buildFoodOverview()
    expect(overview.stats.total).toBe(foodSeed.length)
    expect(overview.stats.bySource.seed).toBe(foodSeed.length)
    // 种子库里本来就有 `鸡蛋(全蛋 生)` / `鸡蛋(水煮)` 这一对
    expect(overview.duplicates.some((group) => group.key === '鸡蛋')).toBe(true)
  })
})

describe('停用（FR-412）', () => {
  it('停用后不再出现在检索与新增候选里，但历史记录与条目本身都还在', async () => {
    await seedLibrary()
    await addIntake(intakeOf(EGG))

    expect(await setDisabled(EGG, true)).toEqual({ ok: true })
    expect((await db.foods.get(EGG))?.disabledFlag).toBe(1)
    expect((await listFoods()).map((food) => food.name)).not.toContain(EGG)
    expect((await searchFoods('鸡蛋(全蛋')).map((food) => food.name)).not.toContain(EGG)
    expect(await listFoods({ includeDisabled: true })).toHaveLength(5)
    // 历史记录不受影响：摄入条目存的是快照（DR-02）
    expect(await countIntakeByFood(EGG)).toBe(1)

    expect(await setDisabled(EGG, false)).toEqual({ ok: true })
    expect((await listFoods()).map((food) => food.name)).toContain(EGG)
  })

  it('对不存在的条目返回失败原因，不抛异常', async () => {
    const outcome = await setDisabled('不存在的食物', true)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('已经不在了')
  })
})

describe('删除保护（FR-412）', () => {
  it('被记录引用过 → 拒绝删除，条目还在，理由说清几条记录', async () => {
    await seedLibrary()
    await addIntake(intakeOf(EGG))
    await addIntake(intakeOf(EGG, 'in_2'))

    const outcome = await deleteFood(EGG)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('2 条记录')
    expect(await db.foods.get(EGG)).toBeDefined()
  })

  it('没有记录用过 → 可以删掉', async () => {
    await seedLibrary()
    expect(await deleteFood(CHICKEN)).toEqual({ ok: true })
    expect(await db.foods.get(CHICKEN)).toBeUndefined()
    expect(await listFoods({ includeDisabled: true })).toHaveLength(4)
  })
})

describe('分组在停用后不变', () => {
  it('停用只是换个 flag，组里照旧看得见（治理页要看得到成对关系）', async () => {
    await seedLibrary()
    await setDisabled(BOILED_EGG, true)
    const [eggGroup] = groupSuspectedDuplicates(await listFoods({ includeDisabled: true }))
    const names = eggGroup.foods.map((food: Food) => food.name)
    expect(names).toHaveLength(2)
    expect(names).toContain(BOILED_EGG)
  })
})
