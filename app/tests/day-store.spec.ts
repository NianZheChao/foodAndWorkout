// @vitest-environment node
/**
 * 记饮食 / 记训练 / 记身体的端到端链路（T1.4 / T1.5）。
 *
 * 这条用例覆盖的是「页面 → store → 仓储 → domain → 汇总落库」的接线，
 * 对拍测试只覆盖 domain 本身，两者互补。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { db } from '@/data/db'
import { getDay } from '@/data/repositories/days'
import { listIntakeByDate } from '@/data/repositories/intake'
import { listWorkoutByDate } from '@/data/repositories/workout'
import { getTargets, putTargets } from '@/data/repositories/targets'
import { seedFoods, findByNormalizedName } from '@/data/repositories/foods'
import { foodSeed, FOOD_SEED_VERSION } from '@/data/seed'
import { factsForGrams } from '@/domain/nutrition'
import { useDayStore } from '@/store/day'

const DATE = '2026-10-13'

async function setup() {
  setActivePinia(createPinia())
  await seedFoods(foodSeed, FOOD_SEED_VERSION)
  await putTargets({
    tdeeKcal: 2846,
    kcalTarget: 2420,
    proteinTargetG: 176,
    fatTargetG: 70,
    carbTargetG: 270,
    fiberTargetG: 30,
    sodiumMaxMg: 2300,
    weeklyTrainingDays: 3,
    weeklySetsPerMuscle: 10,
    targetWeightKg: 65,
    targetRateKgPerWeek: -0.39,
    reviewCadence: 'weekly'
  })
  const store = useDayStore()
  await store.load(DATE)
  return store
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('记饮食 → 汇总', () => {
  it('按克数换算后进入当日汇总，并落库到 summarySnapshot', async () => {
    const store = await setup()
    const egg = await findByNormalizedName('鸡蛋(全蛋 生)')
    if (!egg) throw new Error('种子库里没有鸡蛋')
    const grams = 200

    await store.addFoodEntry({
      meal: '早餐',
      dish: '炒蛋',
      food: egg,
      amount: { qty: grams, unit: 'g', grams },
      computed: factsForGrams(egg, grams)
    })

    const kcalRow = store.summaryRows.find((row) => row.key === 'kcal')
    const proteinRow = store.summaryRows.find((row) => row.key === 'proteinG')
    expect(kcalRow?.intake).toBeCloseTo(egg.kcal * 2, 6)
    expect(proteinRow?.intake).toBeCloseTo(egg.proteinG * 2, 6)
    expect(kcalRow?.target).toBe(2420)
    expect(kcalRow?.ratio).toBeCloseTo((egg.kcal * 2) / 2420, 6)

    expect(await listIntakeByDate(DATE)).toHaveLength(1)
    expect((await getDay(DATE))?.summarySnapshot?.rows[0].intake).toBeCloseTo(egg.kcal * 2, 6)
  })

  it('删除后汇总回到零，不会残留', async () => {
    const store = await setup()
    const egg = await findByNormalizedName('鸡蛋(全蛋 生)')
    if (!egg) throw new Error('种子库里没有鸡蛋')
    await store.addFoodEntry({
      meal: '早餐',
      dish: '炒蛋',
      food: egg,
      amount: { qty: 100, unit: 'g', grams: 100 },
      computed: factsForGrams(egg, 100)
    })
    expect(store.summaryRows[0].intake).toBeCloseTo(egg.kcal, 6)

    await store.removeIntakeEntry(store.intake[0].id)
    expect(store.summaryRows[0].intake).toBe(0)
    expect(store.summary.incomplete).toBe(false)
  })

  it('待补全条目会把汇总标为不完整（模型未配置 / 断网时的占位）', async () => {
    const store = await setup()
    const egg = await findByNormalizedName('鸡蛋(全蛋 生)')
    if (!egg) throw new Error('种子库里没有鸡蛋')
    await store.addFoodEntry({
      meal: '加餐',
      dish: '未知食物',
      food: egg,
      amount: { qty: 1, unit: '份' },
      computed: factsForGrams(egg, 0)
    })
    await store.markPending(store.intake[0].id, true)
    expect(store.pendingCount).toBe(1)
    expect(store.summary.incomplete).toBe(true)
    expect(store.summary.pendingCount).toBe(1)
  })
})

describe('记训练 → 汇总', () => {
  it('容量负荷按组×次×重量计算，自重计 0', async () => {
    const store = await setup()
    await store.addWorkoutEntry({
      type: '力量',
      exercise: '哑铃卧推',
      muscles: ['胸', '三头'],
      minutes: 30,
      rpe: 7,
      sets: Array.from({ length: 3 }, () => ({ reps: 10, weightKg: 20, bodyweight: false })),
      volumeRaw: '3x10x20',
      volumeLoad: 600
    })
    await store.addWorkoutEntry({
      type: '力量',
      exercise: '俯卧撑',
      muscles: ['胸'],
      sets: Array.from({ length: 3 }, () => ({ reps: 15, bodyweight: true })),
      volumeRaw: '3x15x自重'
    })

    expect(store.training.sets).toBe(6)
    expect(store.training.load).toBe(600)
    expect(store.training.bodyweightSets).toBe(3)
    expect(store.training.muscles).toEqual({ 胸: 6, 三头: 3 })
    expect(store.summary.training.volumeLoadKg).toBe(600)
    expect(store.summary.training.isRestDay).toBe(false)
    expect(await listWorkoutByDate(DATE)).toHaveLength(2)
  })
})

describe('记身体 → 汇总与体重序列', () => {
  it('保存晨重后进入序列，并可用于汇总', async () => {
    const store = await setup()
    await store.saveBody({ weightAmKg: 85, weightPmKg: 86.6, sleepHours: 7 })

    expect(store.day?.weightAmKg).toBe(85)
    expect(store.summary.weightAmKg).toBe(85)
    expect(store.weightSeries[DATE]).toBe(85)
    expect(store.bodyWeightForBurn).toEqual({ weightKg: 85, from: DATE })
    expect((await getDay(DATE))?.sleepHours).toBe(7)
  })

  it('只填睡前重时不进入趋势序列', async () => {
    const store = await setup()
    await store.saveBody({ weightPmKg: 86.6 })
    expect(store.weightSeries[DATE]).toBeUndefined()
    expect(store.bodyWeightForBurn).toBeUndefined()
  })
})

describe('目标与口径', () => {
  it('目标存在时才给出差额与占比', async () => {
    const store = await setup()
    expect(store.hasTargets).toBe(true)
    expect((await getTargets())?.kcalTarget).toBe(2420)
    expect(store.summaryRows.every((row) => row.target > 0)).toBe(true)
  })
})

