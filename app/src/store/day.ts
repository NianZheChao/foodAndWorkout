/**
 * 当日会话状态：记录、摄入、训练、目标，以及由 domain 层算出的当日汇总。
 *
 * 所有汇总都是**派生的**：任何写操作之后都会重算并写回 `days.summarySnapshot`，
 * 保证界面、导出与脚本三者看到的是同一套数（docs/pwa-design.md §8.2）。
 */

import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { ensureDay, getDay, listDaysInRange, saveSummary, updateDay } from '@/data/repositories/days'
import {
  addIntake,
  listIntakeByDate,
  removeIntake as removeIntakeRow,
  updateIntake
} from '@/data/repositories/intake'
import { addWorkout, listWorkoutByDate, removeWorkout as removeWorkoutRow } from '@/data/repositories/workout'
import { getTargets } from '@/data/repositories/targets'
import { sumFacts } from '@/domain/nutrition'
import { aggregateWorkouts } from '@/domain/training'
import { buildDaySummary, type TargetValues } from '@/domain/targets'
import { buildWeightSeries, overnightLoss, resolveBodyWeight } from '@/domain/weight'
import { addDays, todayIso } from '@/app/date'
import type { DayRecord, IntakeEntry, Meal, TargetsRecord, WorkoutEntry } from '@/domain/types'

/** 体重窗口：够覆盖「最近一次有效晨重」的兜底查找。 */
const WEIGHT_WINDOW_DAYS = 30

export const useDayStore = defineStore('day', () => {
  const date = ref(todayIso())
  const day = shallowRef<DayRecord>()
  const intake = ref<IntakeEntry[]>([])
  const workout = ref<WorkoutEntry[]>([])
  const targets = shallowRef<TargetsRecord>()
  const weightSeries = ref<Record<string, number>>({})
  /** 前一天的睡前重，用于算夜间净流失（FR-305） */
  const previousEveningKg = ref<number>()
  const loading = ref(false)
  const error = ref<string>()

  const intakeFacts = computed(() => sumFacts(intake.value.map((entry) => entry.computed)))
  const training = computed(() => aggregateWorkouts(workout.value))

  /** 有氧消耗换算用的体重：当日晨重 → 最近一次有效晨重（§5.2）。 */
  const bodyWeightForBurn = computed(() => resolveBodyWeight(weightSeries.value, date.value))

  const targetValues = computed<TargetValues>(() => ({
    kcalTarget: targets.value?.kcalTarget ?? 0,
    proteinTargetG: targets.value?.proteinTargetG ?? 0,
    fatTargetG: targets.value?.fatTargetG ?? 0,
    carbTargetG: targets.value?.carbTargetG ?? 0,
    fiberTargetG: targets.value?.fiberTargetG ?? 0,
    sodiumMaxMg: targets.value?.sodiumMaxMg ?? 0
  }))

  const hasTargets = computed(() => !!targets.value)
  const pendingCount = computed(() => intake.value.filter((entry) => entry.pendingFlag === 1).length)

  /** 夜间净流失 = 当天晨重 − 前一天睡前重；缺一即留空（DR-08）。 */
  const overnightKg = computed(() => overnightLoss(day.value?.weightAmKg, previousEveningKg.value))

  const summary = computed(() =>
    buildDaySummary({
      date: date.value,
      intake: intakeFacts.value,
      targets: targetValues.value,
      weightAmKg: day.value?.weightAmKg,
      weightPmKg: day.value?.weightPmKg,
      training: {
        minutes: training.value.minutes,
        sets: training.value.sets,
        volumeLoadKg: training.value.load,
        isRestDay: training.value.rows === 0
      },
      pendingCount: pendingCount.value,
      computedAt: Date.now()
    })
  )

  async function loadWeightSeries(forDate: string): Promise<void> {
    const rows = await listDaysInRange(addDays(forDate, -WEIGHT_WINDOW_DAYS), forDate)
    weightSeries.value = buildWeightSeries(
      rows.map((row) => ({
        date: row.date,
        weightAmKg: row.weightAmKg,
        weightPmKg: row.weightPmKg
      }))
    ).series
  }

  /** 读取一天的全部状态。切换日期或从别的页面返回时调用。 */
  async function load(forDate: string = date.value): Promise<void> {
    loading.value = true
    error.value = undefined
    try {
      date.value = forDate
      await ensureDay(forDate)
      const [dayRow, intakeRows, workoutRows, targetsRow, previousRow] = await Promise.all([
        getDay(forDate),
        listIntakeByDate(forDate),
        listWorkoutByDate(forDate),
        getTargets(),
        getDay(addDays(forDate, -1))
      ])
      day.value = dayRow
      intake.value = intakeRows
      workout.value = workoutRows
      targets.value = targetsRow
      previousEveningKg.value = previousRow?.weightPmKg
      await loadWeightSeries(forDate)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  /** 重算汇总并落库；写操作之后统一走这里。 */
  async function persistSummary(): Promise<void> {
    if (day.value) await saveSummary(date.value, summary.value)
  }

  async function refresh(): Promise<void> {
    await load(date.value)
    await persistSummary()
  }

  /** 返回新建条目的 id，便于调用方接着标「待补全」（FR-506）。 */
  async function addFoodEntry(input: {
    meal: Meal
    dish: string
    food: IntakeEntry['foodSnapshot'] & { id?: string }
    amount: IntakeEntry['amount']
    computed: IntakeEntry['computed']
    note?: string
  }): Promise<string> {
    const id = await addIntake({
      date: date.value,
      meal: input.meal,
      dish: input.dish,
      foodId: input.food.id ?? input.food.name,
      foodSnapshot: {
        name: input.food.name,
        unit: input.food.unit,
        basisGrams: input.food.basisGrams,
        kcal: input.food.kcal,
        proteinG: input.food.proteinG,
        fatG: input.food.fatG,
        carbG: input.food.carbG,
        fiberG: input.food.fiberG,
        sodiumMg: input.food.sodiumMg
      },
      amount: input.amount,
      computed: input.computed,
      note: input.note
    })
    await refresh()
    return id
  }

  async function addWorkoutEntry(entry: Omit<WorkoutEntry, 'id' | 'date'>): Promise<void> {
    await addWorkout({ ...entry, date: date.value })
    await refresh()
  }

  async function removeIntakeEntry(id: string): Promise<void> {
    await removeIntakeRow(id)
    await refresh()
  }

  async function removeWorkoutEntry(id: string): Promise<void> {
    await removeWorkoutRow(id)
    await refresh()
  }

  /** 标记某条摄入记录待补全（模型未配置或断网时的占位，FR-506 / §6.10）。 */
  async function markPending(id: string, pending: boolean): Promise<void> {
    await updateIntake(id, { pendingFlag: pending ? 1 : 0 })
    await refresh()
  }

  async function saveBody(patch: {
    weightAmKg?: number
    weightPmKg?: number
    sleepHours?: number
    energy?: number
    soreness?: number
    note?: string
  }): Promise<void> {
    await updateDay(date.value, patch)
    await refresh()
  }

  function setDate(next: string): void {
    if (next !== date.value) void load(next)
  }

  return {
    date,
    day,
    intake,
    workout,
    targets,
    weightSeries,
    previousEveningKg,
    loading,
    error,
    intakeFacts,
    training,
    bodyWeightForBurn,
    targetValues,
    hasTargets,
    pendingCount,
    overnightKg,
    summary,
    summaryRows: computed(() => summary.value.rows),
    load,
    refresh,
    persistSummary,
    addFoodEntry,
    addWorkoutEntry,
    removeIntakeEntry,
    removeWorkoutEntry,
    markPending,
    saveBody,
    setDate
  }
})
