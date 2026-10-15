// @vitest-environment node
/**
 * 对拍：`python scripts/nutrition.py tdee`（docs/pwa-design.md §5.3 T1.3）。
 *
 * 两组样本：
 * 1. 仓库真实记录——只有 3 天同时有体重与摄入，脚本给「数据不足」，口径必须一致。
 * 2. 合成 21 天线性样本（tests/fixtures/synthetic/tdee-records.json）——覆盖反推算法本身。
 */

import { describe, expect, it } from 'vitest'
import {
  buildTdeePoints,
  estimateTdee,
  roundToTdeeStep,
  suggestedKcalForRate,
  tdeeConfidence,
  tdeeWarnings,
  type TdeeInputDay
} from '@/domain/tdee'
import { buildWeightSeries, trendWeight } from '@/domain/weight'
import {
  expectClose,
  expectedTable,
  loadRecordFixtures,
  numberOf,
  readFixture
} from './helpers/fixtures'

interface SyntheticRecord {
  date: string
  weightAmKg: number
  kcal: number
}

function realInputDays(): TdeeInputDay[] {
  return loadRecordFixtures().map((record) => {
    const { value, basis } = trendWeight({
      date: record.date,
      weightAmKg: record.weightAmKg,
      weightPmKg: record.weightPmKg,
      legacyWeightKg: record.legacyWeightKg
    })
    return {
      date: record.date,
      weightKg: value,
      basis,
      kcal: record.intake.reduce((sum, row) => sum + row.facts.kcal, 0),
      hasIntakeRows: record.intake.length > 0
    }
  })
}

describe('对拍 tdee：真实记录的样本门槛', () => {
  const points = buildTdeePoints(realInputDays())

  it('只收「有摄入 + 有体重 + 热量 > 0」的天', () => {
    expect(points.map((point) => point.date)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13'])
  })

  it('样本不足时的提示与脚本逐字一致', () => {
    const expected = readFixture('expected-tdee.txt').trim()
    expect(tdeeWarnings(points)).toEqual([expected])
  })

  it('样本不足时只是初步估算', () => {
    expect(estimateTdee(points)).toBeDefined()
    expect(tdeeConfidence(points.length)).toBe('初步估算')
  })
})

describe('对拍 tdee：合成 21 天线性样本', () => {
  const synthetic = JSON.parse(readFixture('synthetic/tdee-records.json')) as SyntheticRecord[]
  const inputDays: TdeeInputDay[] = synthetic.map((record) => ({
    date: record.date,
    weightKg: record.weightAmKg,
    basis: 'am',
    kcal: record.kcal,
    hasIntakeRows: true
  }))
  const points = buildTdeePoints(inputDays)
  const estimate = estimateTdee(points)
  const table = expectedTable('expected-tdee-synthetic.txt', ['指标', '数值'])

  function expectedRow(prefix: string): string[] {
    const row = table.rows.find((item) => (item[0] ?? '').startsWith(prefix))
    if (!row) throw new Error(`期望表缺少以「${prefix}」开头的行`)
    return row
  }

  it('样本数与跨度与脚本一致', () => {
    if (!estimate) throw new Error('估算失败')
    const sampleNumbers = (expectedRow('样本')[1] ?? '').match(/\d+/g)?.map(Number) ?? []
    expect(estimate.sampleDays).toBe(sampleNumbers[0])
    expect(estimate.spanDays).toBe(sampleNumbers[1])
    expect(estimate.basisDays.am).toBe(sampleNumbers[0])
  })

  it('平均摄入 / 稳健斜率 / 最小二乘 / 每日能量差 / TDEE 与脚本一致', () => {
    if (!estimate) throw new Error('估算失败')
    expectClose(estimate.meanIntake, numberOf(table, expectedRow('平均摄入'), '数值'), '平均摄入')
    expectClose(estimate.slope, numberOf(table, expectedRow('体重斜率（稳健'), '数值'), '稳健斜率')
    expectClose(
      estimate.leastSquaresSlope,
      numberOf(table, expectedRow('体重斜率（最小二乘'), '数值'),
      '最小二乘斜率'
    )
    expectClose(estimate.balanceKcal, numberOf(table, expectedRow('每日能量差'), '数值'), '每日能量差')
    expectClose(estimate.tdeeKcal, numberOf(table, expectedRow('实测 TDEE'), '数值'), '实测 TDEE')
  })

  it('TDEE 取 50 的整数倍与目标速率对应热量与脚本一致', () => {
    if (!estimate) throw new Error('估算失败')
    expectClose(roundToTdeeStep(estimate.tdeeKcal), 2850, '取整 TDEE')
    expectClose(
      suggestedKcalForRate(estimate.tdeeKcal, -0.5),
      numberOf(table, expectedRow('目标速率'), '数值'),
      '目标速率对应热量'
    )
  })

  it('样本达到 14 天后判定为可用', () => {
    expect(tdeeConfidence(points.length)).toBe('可用')
  })
})

describe('晨重口径', () => {
  it('优先晨重，旧字段兜底并标记口径不明，睡前单独记录', () => {
    const { series, legacyDates, eveningOnlyDates } = buildWeightSeries([
      { date: '2026-01-01', weightAmKg: 80, legacyWeightKg: 79, weightPmKg: 81 },
      { date: '2026-01-02', legacyWeightKg: 78, weightPmKg: 80 },
      { date: '2026-01-03', weightPmKg: 79 }
    ])
    expect(series).toEqual({ '2026-01-01': 80, '2026-01-02': 78 })
    expect(legacyDates).toEqual(['2026-01-02'])
    expect(eveningOnlyDates).toEqual(['2026-01-03'])
  })
})
