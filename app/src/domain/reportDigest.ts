/**
 * 报告用本地摘要（T3.1 / §6.4）。
 *
 * 这是**喂给模型的全部输入**：只有区间聚合后的数字，没有一条原始记录、没有备注原文、
 * 没有用户原话（省 token，也不把隐私细节送出去）。
 *
 * 口径完全建立在 `domain/trend.ts` 的区间聚合上 —— 趋势页看得见的数、报告摘要里的数、
 * 数字守卫的白名单必须是同一套，否则「模型有没有编数字」就无从判断。
 */

import dayjs from 'dayjs'
import { buildTrend, type TrendDayInput, type TrendTargets } from '@/domain/trend'
import { MIN_TDEE_POINTS } from '@/domain/tdee'
import { isPlausibleWeight } from '@/domain/weight'
import type { ReportDigest, ReportType } from '@/domain/types'

/** 摘要需要比趋势页多两个目标字段（训练天数下限与上次校准日）。 */
export type DigestTargets = TrendTargets & {
  weeklyTrainingDays?: number
  lastCalibrated?: string
}

export interface ReportPeriod {
  type: ReportType
  label: string
  start: string
  end: string
  /** 区间天数（自然日，含没有记录的天） */
  days: number
}

export interface ReportDigestInput {
  period: ReportPeriod
  /** 区间内的每一天，升序；没有记录的天也要占位 */
  days: readonly TrendDayInput[]
  targets: DigestTargets
  /** 上一期的结论文本（月报用于「与上月对比」，周报可不传） */
  previous?: { period: string; conclusion: string }
}

/** ISO 周号：`2026-W41`。周四所在的年份决定跨年周的归属。 */
export function isoWeekLabel(date: string): string {
  const value = dayjs(date)
  const thursday = value.add(4 - ((value.day() + 6) % 7), 'day')
  const year = thursday.year()
  const week = Math.floor(thursday.diff(dayjs(`${year}-01-01`), 'day') / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * 由区间末日推算周期。周报按 **周一到周日**（与工作区 `records/` 的周口径一致），
 * 月报按自然月。
 */
export function periodOf(type: ReportType, endDate: string): ReportPeriod {
  const end = dayjs(endDate)
  if (type === 'weekly') {
    const start = end.subtract((end.day() + 6) % 7, 'day')
    const last = start.add(6, 'day')
    return {
      type,
      label: isoWeekLabel(start.format('YYYY-MM-DD')),
      start: start.format('YYYY-MM-DD'),
      end: last.format('YYYY-MM-DD'),
      days: 7
    }
  }
  const start = end.startOf('month')
  return {
    type,
    label: start.format('YYYY-MM'),
    start: start.format('YYYY-MM-DD'),
    end: end.endOf('month').format('YYYY-MM-DD'),
    days: end.endOf('month').date()
  }
}

/** 一位小数，与脚本 `fmt` 的显示精度一致（避免摘要里出现 2139.58333 这种数）。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 产出报告摘要。所有数字都来自本地计算；缺失一律留空（`undefined`）而不是补 0，
 * 这样模型不会把「没记录」当成「摄入为 0」。
 */
export function buildReportDigest(input: ReportDigestInput): ReportDigest {
  const trend = buildTrend({
    days: input.days,
    targets: input.targets,
    windowDays: input.period.days
  })

  const amSeries = trend.rows
    .filter((row) => row.basis !== '' && isPlausibleWeight(row.weightKg))
    .map((row) => ({ date: row.date, kg: round1(row.weightKg as number) }))

  const digest: ReportDigest = {
    period: {
      type: input.period.type,
      label: input.period.label,
      start: input.period.start,
      end: input.period.end,
      days: input.period.days
    },
    coverage: {
      daysWithIntake: trend.coverage.daysWithIntake,
      daysWithWeight: trend.coverage.daysWithWeight,
      // 「样本够不够」看的是有记录的天数占比：**分母是区间天数**（不是传进来的行数），
      // 这样即使调用方没有把没有记录的天补成占位行，覆盖率也不会被算高（FR-708）。
      // 体重是可选数据，不参与这个门禁。
      ratio:
        input.period.days > 0
          ? round1((trend.coverage.daysWithIntake / input.period.days) * 100) / 100
          : 0
    },
    intake: {
      avgKcal: round1(trend.intake.avg.kcal),
      target: input.targets.kcalTarget,
      avgProteinG: round1(trend.intake.avg.proteinG),
      proteinTargetG: input.targets.proteinTargetG,
      kcalHitDays: trend.intake.kcalHit.hit,
      proteinHitDays: trend.intake.proteinHit.hit,
      recordedDays: trend.intake.days
    },
    weight: {
      amSeries,
      ma7: trend.weight?.latestMa === undefined ? undefined : round1(trend.weight.latestMa),
      changeKg: trend.weight === undefined ? undefined : round1(trend.weight.changeKg),
      changePctPerWeek: trend.weight === undefined ? undefined : round1(trend.weight.pctPerWeek)
    },
    training: {
      days: trend.training.days,
      minutes: trend.training.minutes,
      sets: trend.training.sets,
      volumeLoadKg: round1(trend.training.load),
      byMuscle: trend.training.muscles.map((row) => ({ muscle: row.name, sets: row.sets })),
      targetDays: input.targets.weeklyTrainingDays ?? 0,
      targetSetsPerMuscle: input.targets.weeklySetsPerMuscle ?? 0
    },
    currentTargets: {
      kcalTarget: input.targets.kcalTarget,
      proteinTargetG: input.targets.proteinTargetG,
      lastCalibrated: input.targets.lastCalibrated
    }
  }

  const estimate = trend.tdee.estimate
  // 样本不到门禁就不给数（DR-27）：不能让模型拿着 3 天数据反推出来的 4330 kcal 当事实写进报告
  if (estimate && estimate.sampleDays >= MIN_TDEE_POINTS) {
    digest.tdee = {
      value: Math.round(estimate.tdeeKcal),
      sampleDays: estimate.sampleDays,
      confidence: trend.tdee.confidence === '可用' ? '可用' : '初步估算'
    }
  }
  if (input.previous) {
    digest.previousDigest = { period: input.previous.period, conclusion: input.previous.conclusion.slice(0, 200) }
  }
  return digest
}

/** 覆盖率门禁（FR-708）：低于一半就在报告顶部强制提示，并禁止给校准建议。 */
export const MIN_COVERAGE_RATIO = 0.5

export function coverageWarning(digest: ReportDigest): string | undefined {
  if (digest.coverage.ratio >= MIN_COVERAGE_RATIO) return undefined
  return `区间内只有 ${digest.coverage.daysWithIntake}/${digest.period.days} 天有饮食记录（${Math.round(
    digest.coverage.ratio * 100
  )}%），样本不足，结论仅供方向参考。`
}
