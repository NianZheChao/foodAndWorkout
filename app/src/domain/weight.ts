/**
 * 体重序列：晨重口径、7 日均线、夜间净流失、变化率。
 *
 * 与工作区约定一致：晨重 `weight_am_kg` 是趋势与 TDEE 的唯一基准；
 * 睡前重只用于算夜间净流失；两个都没填就留空，绝不用其他日的值顶替。
 */

import dayjs from 'dayjs'

export const WEIGHT_MIN = 25
export const WEIGHT_MAX = 300

export function isPlausibleWeight(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= WEIGHT_MIN && value <= WEIGHT_MAX
}

export interface WeightLike {
  date: string
  weightAmKg?: number
  weightPmKg?: number
  /** 历史记录的旧字段 `weight_kg`，口径不明，仅作兜底（DR-10） */
  legacyWeightKg?: number
}

export type WeightBasis = 'am' | 'legacy' | ''

/** 趋势与 TDEE 的唯一入口：优先晨重，退回旧字段，都没有则为空。 */
export function trendWeight(day: WeightLike): { value?: number; basis: WeightBasis } {
  if (isPlausibleWeight(day.weightAmKg)) return { value: day.weightAmKg, basis: 'am' }
  if (isPlausibleWeight(day.legacyWeightKg)) return { value: day.legacyWeightKg, basis: 'legacy' }
  return { basis: '' }
}

export function morningWeight(day: WeightLike): number | undefined {
  return isPlausibleWeight(day.weightAmKg) ? day.weightAmKg : undefined
}

/** 夜间净流失 = 当天晨重 − 前一天睡前重；缺一即留空（DR-08）。 */
export function overnightLoss(
  morningKg: number | null | undefined,
  previousEveningKg: number | null | undefined
): number | undefined {
  if (!isPlausibleWeight(morningKg) || !isPlausibleWeight(previousEveningKg)) return undefined
  return morningKg - previousEveningKg
}

export type WeightSeries = Record<string, number>

/**
 * 移动平均：以 `date` 结尾、窗口 `window` 天（含首尾），只统计窗口内真实存在的日期，
 * 缺失日不补零。窗口内无数据返回 undefined。
 */
export function movingAverage(series: WeightSeries, date: string, window = 7): number | undefined {
  const end = dayjs(date)
  const start = end.subtract(window - 1, 'day')
  const values: number[] = []
  for (const [key, value] of Object.entries(series)) {
    const current = dayjs(key)
    if (!current.isBefore(start, 'day') && !current.isAfter(end, 'day')) values.push(value)
  }
  if (!values.length) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 最新一天的均线（脚本用 `max(weights)` 取最后一个日期）。 */
export function latestMovingAverage(series: WeightSeries, window = 7): number | undefined {
  const dates = Object.keys(series).sort()
  if (!dates.length) return undefined
  return movingAverage(series, dates[dates.length - 1], window)
}

/** 由日期升序的记录构建晨重序列（旧字段兜底，与脚本 `trend` 一致）。 */
export function buildWeightSeries(days: readonly WeightLike[]): {
  series: WeightSeries
  legacyDates: string[]
  eveningOnlyDates: string[]
} {
  const series: WeightSeries = {}
  const legacyDates: string[] = []
  const eveningOnlyDates: string[] = []
  for (const day of days) {
    const { value, basis } = trendWeight(day)
    if (value !== undefined) {
      series[day.date] = value
      if (basis === 'legacy') legacyDates.push(day.date)
    } else if (isPlausibleWeight(day.weightPmKg)) {
      eveningOnlyDates.push(day.date)
    }
  }
  return { series, legacyDates, eveningOnlyDates }
}

export interface WeightChange {
  first: number
  last: number
  changeKg: number
  spanDays: number
  /** 周化变化量 = change / spanDays × 7 */
  perWeekKg: number
  /** 周化百分比（相对首值） */
  pctPerWeek: number
}

/** 区间变化率：与脚本 `trend_summary` 一致（首末有效值、按跨度周化）。 */
export function weightChange(series: WeightSeries, dates: readonly string[]): WeightChange | undefined {
  const points = dates.filter((date) => series[date] !== undefined).sort()
  if (points.length < 2) return undefined
  const first = series[points[0]]
  const last = series[points[points.length - 1]]
  const spanDays = Math.max(dayjs(points[points.length - 1]).diff(dayjs(points[0]), 'day'), 1)
  const changeKg = last - first
  const perWeekKg = (changeKg / spanDays) * 7
  return {
    first,
    last,
    changeKg,
    spanDays,
    perWeekKg,
    pctPerWeek: first ? (perWeekKg / first) * 100 : 0
  }
}

/**
 * 取用于有氧消耗换算的体重：当日晨重 → 最近一个有效晨重 → undefined。
 * 返回 undefined 时调用方必须留空并提示，不允许编一个体重（DR-49）。
 */
export function resolveBodyWeight(
  series: WeightSeries,
  date: string
): { weightKg: number; from: string } | undefined {
  if (series[date] !== undefined) return { weightKg: series[date], from: date }
  const earlier = Object.keys(series)
    .filter((key) => key < date)
    .sort()
  const latest = earlier[earlier.length - 1]
  if (!latest) return undefined
  return { weightKg: series[latest], from: latest }
}

export function previousDate(date: string): string {
  return dayjs(date).subtract(1, 'day').format('YYYY-MM-DD')
}

