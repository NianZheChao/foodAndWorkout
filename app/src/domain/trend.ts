/**
 * 区间聚合：趋势页（M6 / FR-600）用的日表、区间小结、训练明细与 TDEE 反推。
 *
 * 口径与 `scripts/nutrition.py trend` 一致（docs/pwa-design.md §5.2 / §5.3）：
 * - 体重序列只收晨重（旧字段 `weight_kg` 兜底并标记口径不明），睡前重不进均线
 * - 区间不足 7 天不外推周均（`weeklyExtrapolated === false`）
 * - 容量负荷自重不计，肌群组数与动作明细按区间求和
 * - 分母一律是「有记录天数」，没记录的天不参与统计
 *
 * 纯函数：无 IO、不读时钟，时间与数据都由调用方传入。
 */

import { hitRate, kcalHit, proteinHit, type HitRate } from '@/domain/adherence'
import { emptyFacts, sumFacts } from '@/domain/nutrition'
import { aggregateWorkouts, rankMoves, type MoveAggregate, type TrainingAggregate } from '@/domain/training'
import { buildSummaryRows, type TargetValues } from '@/domain/targets'
import {
  buildTdeePoints,
  estimateTdee,
  tdeeConfidence,
  tdeeWarnings,
  type TdeeEstimate
} from '@/domain/tdee'
import {
  buildWeightSeries,
  isPlausibleWeight,
  latestMovingAverage,
  morningWeight,
  movingAverage,
  overnightLoss,
  previousDate,
  trendWeight,
  weightChange,
  type WeightBasis
} from '@/domain/weight'
import type { DaySummaryRow, NutritionFacts, WorkoutEntry } from '@/domain/types'

/** 区间窗口（FR-606：7 / 14 / 28 天）。 */
export const TREND_WINDOWS = [7, 14, 28] as const
export type TrendWindow = (typeof TREND_WINDOWS)[number]
export const DEFAULT_TREND_WINDOW: TrendWindow = 7
/** 均线窗口固定 7 天（FR-601）。 */
export const MA_WINDOW = 7

/** 把 URL / 表单里的值收敛到允许的窗口，非法值退回默认。 */
export function normalizeTrendWindow(value: unknown): TrendWindow {
  const parsed = Number(value)
  return (TREND_WINDOWS as readonly number[]).includes(parsed) ? (parsed as TrendWindow) : DEFAULT_TREND_WINDOW
}

export interface TrendDayInput {
  date: string
  weightAmKg?: number
  weightPmKg?: number
  /** 历史记录的旧字段 `weight_kg`，口径不明，仅作兜底（DR-10） */
  legacyWeightKg?: number
  /** 当日摄入汇总（六项）；没有记录时传空值并把 `hasIntakeRows` 置 false */
  intake: NutritionFacts
  hasIntakeRows: boolean
  workouts: readonly WorkoutEntry[]
}

export interface TrendInput {
  /** 区间内的天，升序；调用方自己负责按窗口截取 */
  days: readonly TrendDayInput[]
  targets: TrendTargets
  /**
   * 区间前一天。脚本算首行「夜间净流失」时会去读前一天的记录，
   * 页面只加载窗口内的天，所以要显式把前一天传进来。
   */
  previousDay?: TrendDayInput
  /**
   * 请求的窗口天数（7 / 14 / 28）。用于判断「区间不足 7 天不外推周均」（FR-606）：
   * 页面按日历天铺满窗口时，样本天数与窗口天数不是一回事。缺省取实际行数。
   */
  windowDays?: number
  maWindow?: number
}

/** 区间聚合需要的目标：当日汇总的六项 + 每肌群组数下限（用于「低于下限」提示）。 */
export type TrendTargets = TargetValues & { weeklySetsPerMuscle?: number }

export interface TrendDailyRow {
  date: string
  weightAmKg?: number
  weightPmKg?: number
  /** 趋势口径体重（晨重优先、旧字段兜底），与 `basis` 对应 */
  weightKg?: number
  /** 趋势口径：`am` 晨重 / `legacy` 旧字段兜底 / `''` 无 */
  basis: WeightBasis
  /** 用旧字段兜底时为 true，界面上要标 `*`（口径不明） */
  legacy: boolean
  overnightKg?: number
  ma?: number
  intake: NutritionFacts
  hasIntakeRows: boolean
  minutes: number
  sets: number
  load: number
  hasTraining: boolean
}

export interface TrendCoverage {
  days: number
  daysWithIntake: number
  daysWithWeight: number
  daysWithLegacyWeight: number
  /** 只有睡前重、缺晨重的天数（不进入均线与 TDEE，FR-607） */
  daysEveningOnly: number
  daysWithTraining: number
  intakeRatio: number
  weightRatio: number
}

export interface TrendWeightSummary {
  first: number
  last: number
  changeKg: number
  spanDays: number
  perWeekKg: number
  pctPerWeek: number
  latestMa?: number
  maWindow: number
}

export interface TrendIntakeSummary {
  /** 有摄入记录的天数（所有分母都是它） */
  days: number
  avg: NutritionFacts
  total: NutritionFacts
  /** 日均 vs 目标，复用当日汇总的行结构 */
  rows: DaySummaryRow[]
  kcalHit: HitRate
  proteinHit: HitRate
}

export interface TrendMuscleRow {
  name: string
  sets: number
  load: number
  /** 周均组数；区间不足 7 天时为 undefined（不外推） */
  perWeekSets?: number
}

export interface TrendTrainingSummary {
  /** 有训练记录的天数 */
  days: number
  minutes: number
  sets: number
  load: number
  /** 区间内全部训练条目（含自重动作），供动作明细使用 */
  aggregate: TrainingAggregate
  /** 区间 ≥ 7 天才外推周均（FR-606 / 脚本口径） */
  weeklyExtrapolated: boolean
  /** 周均训练天数；不足 7 天时为 undefined */
  perWeekDays?: number
  muscles: TrendMuscleRow[]
}

export interface TrendTdeeSummary {
  estimate?: TdeeEstimate
  warnings: string[]
  /** 样本达到门槛才是「可用」，否则只是初步估算（DR-27） */
  confidence: '初步估算' | '可用' | ''
}

export interface TrendResult {
  start?: string
  end?: string
  /** 区间内的日历天数（页面铺满窗口，含没有记录的天） */
  days: number
  /** 请求的窗口天数（7 / 14 / 28） */
  windowDays: number
  maWindow: number
  /** 区间内没有任何记录（区分「未记录」与「0」，FR-607） */
  empty: boolean
  rows: TrendDailyRow[]
  coverage: TrendCoverage
  weight?: TrendWeightSummary
  intake: TrendIntakeSummary
  training: TrendTrainingSummary
  moves: [string, MoveAggregate][]
  tdee: TrendTdeeSummary
  /** 需要用户知道的样本问题（旧字段兜底、只有睡前重、低于组数下限） */
  notes: string[]
}

function toWeightLike(day: TrendDayInput) {
  return {
    date: day.date,
    weightAmKg: day.weightAmKg,
    weightPmKg: day.weightPmKg,
    legacyWeightKg: day.legacyWeightKg
  }
}

/** 六项整体除以天数；天数为 0 时返回全 0。 */
function divideFacts(facts: NutritionFacts, days: number): NutritionFacts {
  if (!days) return emptyFacts()
  return {
    kcal: facts.kcal / days,
    proteinG: facts.proteinG / days,
    fatG: facts.fatG / days,
    carbG: facts.carbG / days,
    fiberG: facts.fiberG / days,
    sodiumMg: facts.sodiumMg / days
  }
}

/** 区间聚合入口。 */
export function buildTrend(input: TrendInput): TrendResult {
  const maWindow = input.maWindow ?? MA_WINDOW
  const ordered = [...input.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const byDate = new Map(ordered.map((day) => [day.date, day]))
  const series = buildWeightSeries(ordered.map(toWeightLike)).series

  const rows: TrendDailyRow[] = ordered.map((day) => {
    const { value, basis } = trendWeight(day)
    const am = morningWeight(day)
    const training = aggregateWorkouts(day.workouts)
    const before = byDate.get(previousDate(day.date))
    const previousEveningKg =
      before?.weightPmKg ?? (input.previousDay?.date === previousDate(day.date) ? input.previousDay.weightPmKg : undefined)
    return {
      date: day.date,
      weightAmKg: am,
      weightPmKg: isPlausibleWeight(day.weightPmKg) ? day.weightPmKg : undefined,
      weightKg: value,
      basis,
      legacy: basis === 'legacy',
      overnightKg: am === undefined ? undefined : overnightLoss(am, previousEveningKg),
      ma: movingAverage(series, day.date, maWindow),
      intake: day.intake,
      hasIntakeRows: day.hasIntakeRows,
      minutes: training.minutes,
      sets: training.sets,
      load: training.load,
      hasTraining: training.rows > 0
    }
  })

  const intakeDays = rows.filter((row) => row.hasIntakeRows)
  const trainingDays = rows.filter((row) => row.hasTraining)
  const legacyDates = rows.filter((row) => row.legacy).map((row) => row.date)
  const eveningOnlyDates = rows
    .filter((row) => row.basis === '' && isPlausibleWeight(row.weightPmKg))
    .map((row) => row.date)

  const coverage: TrendCoverage = {
    days: rows.length,
    daysWithIntake: intakeDays.length,
    daysWithWeight: rows.filter((row) => row.basis !== '').length,
    daysWithLegacyWeight: legacyDates.length,
    daysEveningOnly: eveningOnlyDates.length,
    daysWithTraining: trainingDays.length,
    intakeRatio: rows.length ? intakeDays.length / rows.length : 0,
    weightRatio: rows.length ? rows.filter((row) => row.basis !== '').length / rows.length : 0
  }

  const change = weightChange(series, rows.map((row) => row.date))
  const weight: TrendWeightSummary | undefined = change && {
    ...change,
    latestMa: latestMovingAverage(series, maWindow),
    maWindow
  }

  const total = intakeDays.length
    ? sumFacts(intakeDays.map((row) => row.intake))
    : emptyFacts()
  /** 日均 = 区间合计 / 有记录天数；没有记录就是 0（不参与达标分母）。 */
  const averaged = divideFacts(total, intakeDays.length)

  const intake: TrendIntakeSummary = {
    days: intakeDays.length,
    avg: averaged,
    total,
    rows: buildSummaryRows(averaged, input.targets),
    kcalHit: hitRate(intakeDays.map((row) => kcalHit(row.intake.kcal, input.targets.kcalTarget))),
    proteinHit: hitRate(intakeDays.map((row) => proteinHit(row.intake.proteinG, input.targets.proteinTargetG)))
  }

  const aggregate = aggregateWorkouts(ordered.flatMap((day) => [...day.workouts]))
  const windowDays = Math.max(1, Math.round(input.windowDays ?? rows.length))
  const weeklyExtrapolated = windowDays >= 7
  const weeks = windowDays / 7
  const muscles: TrendMuscleRow[] = Object.entries(aggregate.muscles)
    .map(([name, sets]) => ({
      name,
      sets,
      load: aggregate.muscleLoad[name] ?? 0,
      perWeekSets: weeklyExtrapolated ? sets / weeks : undefined
    }))
    // 只按组数降序：与脚本的稳定排序一致（并列时保持动作首次出现的顺序）
    .sort((a, b) => b.sets - a.sets)

  const training: TrendTrainingSummary = {
    days: trainingDays.length,
    minutes: aggregate.minutes,
    sets: aggregate.sets,
    load: aggregate.load,
    aggregate,
    weeklyExtrapolated,
    perWeekDays: weeklyExtrapolated ? trainingDays.length / weeks : undefined,
    muscles
  }

  const notes: string[] = []
  if (legacyDates.length) {
    notes.push('带 * 的是旧字段 weight_kg（没有晨重的历史记录，口径不明），只作兜底。')
  }
  if (eveningOnlyDates.length) {
    notes.push(`只有睡前体重的日期（${eveningOnlyDates.join('、')}）：不进入均线与 TDEE，需要补晨重。`)
  }
  if (weeklyExtrapolated && input.targets.weeklySetsPerMuscle) {
    const floor = input.targets.weeklySetsPerMuscle
    const low = muscles.filter((row) => (row.perWeekSets ?? 0) < floor).map((row) => row.name)
    if (low.length) notes.push(`低于每周有效组数下限（${floor} 组）：${low.join('、')}`)
  }

  const points = buildTdeePoints(
    rows.map((row) => ({
      date: row.date,
      weightKg: row.weightKg,
      basis: row.basis,
      kcal: row.intake.kcal,
      hasIntakeRows: row.hasIntakeRows
    }))
  )
  const estimate = estimateTdee(points)
  const tdee: TrendTdeeSummary = {
    estimate,
    warnings: tdeeWarnings(points, estimate),
    confidence: estimate ? tdeeConfidence(estimate.sampleDays) : ''
  }

  return {
    start: rows[0]?.date,
    end: rows[rows.length - 1]?.date,
    days: rows.length,
    windowDays,
    maWindow,
    empty: rows.every(
      (row) => !row.hasIntakeRows && !row.hasTraining && row.basis === '' && row.weightPmKg === undefined
    ),
    rows,
    coverage,
    weight,
    intake,
    training,
    moves: rankMoves(aggregate.moves),
    tdee,
    notes
  }
}
