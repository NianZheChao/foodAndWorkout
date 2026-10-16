/**
 * 不依赖 Pinia 的当日汇总重算（T4.1 / §7.4 第 5 步：导入后回填受影响日期）。
 *
 * 为什么单独抽一份：导入、快照回滚这类"批量改库"的流程跑在 store 之外，
 * 不能为了算一行汇总去把 `useDayStore` 的当前日期改来改去。
 *
 * **口径必须与 `store/day.ts` 的 `summary` 完全一致**，否则导入后页面显示的数字会和记录对不上。
 * `tests/day-summary.spec.ts` 用同一天的数据同时跑两边、断言逐字段相等，把两处钉在一起。
 */

import { getDay, saveSummary } from '@/data/repositories/days'
import { listIntakeByDate } from '@/data/repositories/intake'
import { listWorkoutByDate } from '@/data/repositories/workout'
import { getTargets } from '@/data/repositories/targets'
import { sumFacts } from '@/domain/nutrition'
import { aggregateWorkouts } from '@/domain/training'
import { buildDaySummary } from '@/domain/targets'
import type { DaySummary, TargetsRecord } from '@/domain/types'

function targetValuesOf(targets?: TargetsRecord) {
  return {
    kcalTarget: targets?.kcalTarget ?? 0,
    proteinTargetG: targets?.proteinTargetG ?? 0,
    fatTargetG: targets?.fatTargetG ?? 0,
    carbTargetG: targets?.carbTargetG ?? 0,
    fiberTargetG: targets?.fiberTargetG ?? 0,
    sodiumMaxMg: targets?.sodiumMaxMg ?? 0
  }
}

/** 算一天的汇总；这一天没有记录（`days` 里没有行）时返回 `undefined`。 */
export async function buildSummaryForDate(date: string): Promise<DaySummary | undefined> {
  const [dayRow, intakeRows, workoutRows, targetsRow] = await Promise.all([
    getDay(date),
    listIntakeByDate(date),
    listWorkoutByDate(date),
    getTargets()
  ])
  if (!dayRow) return undefined
  const facts = sumFacts(intakeRows.map((entry) => entry.computed))
  const training = aggregateWorkouts(workoutRows)
  return buildDaySummary({
    date,
    intake: facts,
    targets: targetValuesOf(targetsRow),
    weightAmKg: dayRow.weightAmKg,
    weightPmKg: dayRow.weightPmKg,
    training: {
      minutes: training.minutes,
      sets: training.sets,
      volumeLoadKg: training.load,
      isRestDay: training.rows === 0
    },
    pendingCount: intakeRows.filter((entry) => entry.pendingFlag === 1).length,
    computedAt: Date.now()
  })
}

/** 重算并落库；返回是否真的写了（没有这一天时为 false）。 */
export async function recomputeDaySummary(date: string): Promise<boolean> {
  const summary = await buildSummaryForDate(date)
  if (!summary) return false
  await saveSummary(date, summary)
  return true
}
