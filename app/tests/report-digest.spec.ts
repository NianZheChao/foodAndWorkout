// @vitest-environment node
/**
 * 报告摘要（T3.1 / §6.4）。
 *
 * 摘要里的每个数都要能在趋势页（`domain/trend.ts`，已与脚本对拍）找到出处 ——
 * 这一份测试就是把两边的数摆在一起比对，防止「报告的数」和「趋势的数」漂移。
 */

import { describe, expect, it } from 'vitest'
import { buildReportDigest, coverageWarning, isoWeekLabel, MIN_COVERAGE_RATIO, periodOf } from '@/domain/reportDigest'
import { buildTrend, type TrendDayInput } from '@/domain/trend'
import { factsOf, loadRecordFixtures, loadTargetsFixture, toIntakeEntries, toWorkoutEntries } from './helpers/fixtures'

const targets = {
  ...loadTargetsFixture(),
  weeklyTrainingDays: 3,
  weeklySetsPerMuscle: 10,
  lastCalibrated: '2026-10-10'
}

const records = loadRecordFixtures()
const days: TrendDayInput[] = records.map((record) => ({
  date: record.date,
  weightAmKg: record.weightAmKg,
  weightPmKg: record.weightPmKg,
  legacyWeightKg: record.legacyWeightKg,
  intake: factsOf(toIntakeEntries(record).map((entry) => entry.computed)),
  hasIntakeRows: record.intake.length > 0,
  workouts: toWorkoutEntries(record)
}))

const period = { type: 'weekly' as const, label: '2026-W41', start: '2026-10-09', end: '2026-10-15', days: 7 }
const digest = buildReportDigest({ period, days, targets })
const trend = buildTrend({ days, targets, windowDays: period.days })

describe('周期推算', () => {
  it('周报按周一到周日，标签是 ISO 周号', () => {
    // 2026-10-11 是周日，属于 2026-W41（2026-10-05 ~ 10-11）
    expect(periodOf('weekly', '2026-10-11')).toEqual({
      type: 'weekly',
      label: '2026-W41',
      start: '2026-10-05',
      end: '2026-10-11',
      days: 7
    })
    expect(isoWeekLabel('2026-10-05')).toBe('2026-W41')
    expect(isoWeekLabel('2026-10-11')).toBe('2026-W41')
    expect(isoWeekLabel('2026-10-12')).toBe('2026-W42')
  })

  it('月报按自然月，天数跟着月份走', () => {
    expect(periodOf('monthly', '2026-10-15')).toEqual({
      type: 'monthly',
      label: '2026-10',
      start: '2026-10-01',
      end: '2026-10-31',
      days: 31
    })
    expect(periodOf('monthly', '2026-02-10').days).toBe(28)
  })
})

describe('摘要与趋势页同源', () => {
  it('区间与覆盖率来自同一份聚合', () => {
    expect(digest.period).toEqual({ ...period, type: 'weekly' })
    expect(digest.coverage.daysWithIntake).toBe(trend.coverage.daysWithIntake)
    expect(digest.coverage.daysWithWeight).toBe(trend.coverage.daysWithWeight)
    // 覆盖率的分母是区间天数（7），不是这次传进来的 5 行
    expect(digest.coverage.ratio).toBeCloseTo(digest.coverage.daysWithIntake / period.days, 2)
  })

  it('日均摄入 / 达标天数与趋势一致', () => {
    expect(digest.intake.avgKcal).toBeCloseTo(trend.intake.avg.kcal, 1)
    expect(digest.intake.avgProteinG).toBeCloseTo(trend.intake.avg.proteinG, 1)
    expect(digest.intake.recordedDays).toBe(trend.intake.days)
    expect(digest.intake.kcalHitDays).toBe(trend.intake.kcalHit.hit)
    expect(digest.intake.proteinHitDays).toBe(trend.intake.proteinHit.hit)
    expect(digest.intake.target).toBe(targets.kcalTarget)
  })

  it('体重序列只收趋势口径，均线与变化率与趋势一致', () => {
    expect(digest.weight.amSeries.map((point) => point.date)).toEqual(
      trend.rows.filter((row) => row.basis !== '').map((row) => row.date)
    )
    // 只有睡前重的那天（2026-10-10）不进来
    expect(digest.weight.amSeries.some((point) => point.date === '2026-10-10')).toBe(false)
    expect(digest.weight.ma7).toBeCloseTo(trend.weight?.latestMa ?? NaN, 1)
    expect(digest.weight.changeKg).toBeCloseTo(trend.weight?.changeKg ?? NaN, 1)
  })

  it('训练聚合与逐肌群组数与趋势一致', () => {
    expect(digest.training.days).toBe(trend.training.days)
    expect(digest.training.minutes).toBe(trend.training.minutes)
    expect(digest.training.sets).toBe(trend.training.sets)
    expect(digest.training.volumeLoadKg).toBeCloseTo(trend.training.load, 1)
    expect(digest.training.byMuscle).toEqual(
      trend.training.muscles.map((row) => ({ muscle: row.name, sets: row.sets }))
    )
    expect(digest.training.targetDays).toBe(3)
    expect(digest.training.targetSetsPerMuscle).toBe(10)
  })

  it('当前目标与上次校准日原样带上（模型不该猜）', () => {
    expect(digest.currentTargets).toEqual({
      kcalTarget: targets.kcalTarget,
      proteinTargetG: targets.proteinTargetG,
      lastCalibrated: '2026-10-10'
    })
  })

  it('样本不足时反推不出 TDEE 就不写进摘要（DR-27）', () => {
    // fixture 只有 3 天同时有体重与摄入，达不到 7 天门禁
    expect(digest.tdee).toBeUndefined()
  })
})

describe('覆盖率门禁（FR-708）', () => {
  it('有记录天数不到一半就给出提示文案（含天数与占比）', () => {
    const thin = buildReportDigest({
      period,
      days: days.map((day, index) => ({ ...day, hasIntakeRows: index < 2 })),
      targets
    })
    expect(thin.coverage.ratio).toBeLessThan(MIN_COVERAGE_RATIO)
    expect(coverageWarning(thin)).toContain('样本不足')
    expect(coverageWarning(thin)).toContain('2/7')
    expect(coverageWarning(thin)).toContain('29%')
  })

  it('覆盖率够时不提示（fixture 是 4/7 = 80%）', () => {
    expect(digest.coverage.ratio).toBeGreaterThan(MIN_COVERAGE_RATIO)
    expect(coverageWarning(digest)).toBeUndefined()
  })
})

describe('摘要里不放原始记录', () => {
  it('序列化后不含备注原文、菜品名与食材名', () => {
    const text = JSON.stringify(digest)
    for (const record of records) {
      for (const row of record.intake) expect(text).not.toContain(row.foodName)
    }
    expect(text).not.toContain('早餐')
    expect(text).not.toContain('做法')
  })

  it('上一期只带结论文本（截断 200 字）', () => {
    const withPrevious = buildReportDigest({
      period,
      days,
      targets,
      previous: { period: '2026-W40', conclusion: 'x'.repeat(500) }
    })
    expect(withPrevious.previousDigest?.period).toBe('2026-W40')
    expect(withPrevious.previousDigest?.conclusion).toHaveLength(200)
  })
})
