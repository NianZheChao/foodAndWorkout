// @vitest-environment jsdom
/**
 * 「同一套口径」的钉子（T4.1）。
 *
 * `application/daySummary.ts` 是给导入 / 快照这类"跑在 store 之外"的流程用的当日汇总重算。
 * 它必须与 `store/day.ts` 的 `summary` 逐字段一致，否则导入之后页面显示的数字会和记录对不上。
 * 这里用同一天的数据同时跑两边，把两处钉在一起。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { buildSummaryForDate } from '@/application/daySummary'
import { useDayStore } from '@/store/day'
import { db } from '@/data/db'
import { addIntake } from '@/data/repositories/intake'
import { addWorkout } from '@/data/repositories/workout'
import { updateDay } from '@/data/repositories/days'
import { putTargets } from '@/data/repositories/targets'
import type { DaySummary } from '@/domain/types'

const DATE = '2026-10-15'

/** `computedAt` 两边都取 `Date.now()`，比较前抹掉。 */
function strip(summary: DaySummary): DaySummary {
  return { ...summary, computedAt: 0 }
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('当日汇总：store 与 headless 重算同口径', () => {
  it('同一天的数据，两边逐字段相等', async () => {
    await updateDay(DATE, { weightAmKg: 75.1, weightPmKg: 75.6, sleepHours: 6.5 })
    await addIntake({
      date: DATE,
      meal: '午餐',
      dish: '测试餐',
      foodId: '测试食材',
      foodSnapshot: { name: '测试食材', unit: '100g', kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 },
      amount: { qty: 1, unit: '100g', grams: 100 },
      computed: { kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 }
    })
    await addWorkout({ date: DATE, type: '力量', exercise: '杠铃划船', muscles: ['背'], minutes: 45 })
    await putTargets({
      tdeeKcal: 2600,
      kcalTarget: 2100,
      proteinTargetG: 150,
      fatTargetG: 70,
      carbTargetG: 270,
      fiberTargetG: 30,
      sodiumMaxMg: 2000,
      weeklyTrainingDays: 3,
      weeklySetsPerMuscle: 10,
      targetWeightKg: 65,
      targetRateKgPerWeek: -0.39,
      reviewCadence: 'weekly'
    })

    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useDayStore()
    await store.load(DATE)

    const headless = await buildSummaryForDate(DATE)
    expect(headless).toBeDefined()
    expect(strip(store.summary)).toEqual(strip(headless as DaySummary))
  })

  it('这一天没有记录时返回 undefined（不凭空造 0）', async () => {
    expect(await buildSummaryForDate('2026-01-01')).toBeUndefined()
  })
})
