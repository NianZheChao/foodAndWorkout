/**
 * 由「摄入 vs 体重变化」反推实测 TDEE。
 *
 * 与 `scripts/nutrition.py` 的 `cmd_tdee` 一致：
 * - 只收「当天有摄入记录 + 有体重 + 热量 > 0」的天（DR-27）
 * - 斜率用 Theil-Sen（两两斜率取中位数，对离群体重稳健），最小二乘只作参考
 * - 每日能量差 = 斜率 × 7700 kcal/kg；实测 TDEE = 平均摄入 − 每日能量差
 */

import dayjs from 'dayjs'
import type { WeightBasis } from '@/domain/weight'

export const KCAL_PER_KG = 7700
export const MIN_TDEE_POINTS = 7
/** 样本达到这个天数才算「可用」，否则只是初步估算（§5.2 / DR-27）。 */
export const RELIABLE_SAMPLE_DAYS = 14
/** TDEE 建议取 50 的整数倍。 */
export const TDEE_STEP = 50

export interface TdeeInputDay {
  date: string
  /** 趋势口径体重（晨重优先） */
  weightKg?: number
  basis?: WeightBasis
  kcal: number
  /** 当日是否有摄入记录行 */
  hasIntakeRows: boolean
}

export interface TdeePoint {
  date: string
  dayOffset: number
  weightKg: number
  kcal: number
  basis: WeightBasis
}

/** 按脚本口径筛选出可用于拟合的点（日期升序，偏移量以首个有效日为 0）。 */
export function buildTdeePoints(days: readonly TdeeInputDay[]): TdeePoint[] {
  const ordered = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const points: TdeePoint[] = []
  let base: string | undefined
  for (const day of ordered) {
    if (!day.hasIntakeRows) continue
    if (day.weightKg === undefined) continue
    if (day.kcal <= 0) continue
    base ??= day.date
    points.push({
      date: day.date,
      dayOffset: dayjs(day.date).diff(dayjs(base), 'day'),
      weightKg: day.weightKg,
      kcal: day.kcal,
      basis: day.basis ?? ''
    })
  }
  return points
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Theil-Sen 稳健斜率：两两斜率取中位数。 */
export function theilSenSlope(xs: readonly number[], ys: readonly number[]): number | undefined {
  const slopes: number[] = []
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      const dx = xs[j] - xs[i]
      if (dx) slopes.push((ys[j] - ys[i]) / dx)
    }
  }
  return median(slopes)
}

/** 最小二乘斜率，只作参考对照。 */
export function leastSquaresSlope(xs: readonly number[], ys: readonly number[]): number {
  if (!xs.length) return 0
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length
  const variance = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0)
  if (!variance) return 0
  return xs.reduce((sum, x, index) => sum + (x - meanX) * (ys[index] - meanY), 0) / variance
}

export interface TdeeEstimate {
  sampleDays: number
  spanDays: number
  meanIntake: number
  /** 稳健斜率（kg/天） */
  slope: number
  /** 最小二乘斜率（kg/天），仅参考 */
  leastSquaresSlope: number
  /** 每日能量差 = slope × 7700（负值表示在减重） */
  balanceKcal: number
  tdeeKcal: number
  basisDays: { am: number; legacy: number }
}

/** 点为「摄入 − 体重」配对；样本不足或斜率无法估计时返回 undefined。 */
export function estimateTdee(points: readonly TdeePoint[]): TdeeEstimate | undefined {
  if (points.length < 2) return undefined
  const xs = points.map((point) => point.dayOffset)
  const ys = points.map((point) => point.weightKg)
  const slope = theilSenSlope(xs, ys)
  if (slope === undefined) return undefined
  const meanIntake = points.reduce((sum, point) => sum + point.kcal, 0) / points.length
  const balanceKcal = slope * KCAL_PER_KG
  const basisDays = { am: 0, legacy: 0 }
  for (const point of points) {
    if (point.basis === 'am') basisDays.am += 1
    else if (point.basis === 'legacy') basisDays.legacy += 1
  }
  return {
    sampleDays: points.length,
    spanDays: points[points.length - 1].dayOffset - points[0].dayOffset,
    meanIntake,
    slope,
    leastSquaresSlope: leastSquaresSlope(xs, ys),
    balanceKcal,
    tdeeKcal: meanIntake - balanceKcal,
    basisDays
  }
}

/** TDEE 取 50 的整数倍。 */
export function roundToTdeeStep(value: number): number {
  return Math.round(value / TDEE_STEP) * TDEE_STEP
}

/** 目标速率对应的热量：tdee + rate × 7700 / 7。 */
export function suggestedKcalForRate(tdeeKcal: number, rateKgPerWeek: number): number {
  return tdeeKcal + (rateKgPerWeek * KCAL_PER_KG) / 7
}

export function tdeeConfidence(sampleDays: number): '初步估算' | '可用' {
  return sampleDays >= RELIABLE_SAMPLE_DAYS ? '可用' : '初步估算'
}

/** 样本门槛判断，返回需要展示给用户的提示（无问题则空数组）。 */
export function tdeeWarnings(points: readonly TdeePoint[], estimate?: TdeeEstimate): string[] {
  const warnings: string[] = []
  if (points.length < MIN_TDEE_POINTS) {
    warnings.push(`有效数据不足：需要至少 ${MIN_TDEE_POINTS} 天同时有体重和饮食记录，当前 ${points.length} 天。`)
    return warnings
  }
  if (estimate && estimate.spanDays < 10) {
    warnings.push(`时间跨度只有 ${estimate.spanDays} 天，反推结果不可靠，建议至少 14 天。`)
  }
  return warnings
}

