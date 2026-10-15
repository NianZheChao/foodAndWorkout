import { describe, expect, it } from 'vitest'
import {
  buildWeightSeries,
  isPlausibleWeight,
  latestMovingAverage,
  movingAverage,
  overnightLoss,
  previousDate,
  resolveBodyWeight,
  trendWeight,
  weightChange
} from '@/domain/weight'

describe('体重口径', () => {
  it('只在 25–300 kg 之间才当成有效体重', () => {
    expect(isPlausibleWeight(70)).toBe(true)
    expect(isPlausibleWeight(24.9)).toBe(false)
    expect(isPlausibleWeight(300.1)).toBe(false)
    expect(isPlausibleWeight(Number.NaN)).toBe(false)
    expect(isPlausibleWeight(undefined)).toBe(false)
  })

  it('趋势基准优先晨重，其次旧字段', () => {
    expect(trendWeight({ date: 'd', weightAmKg: 70, legacyWeightKg: 84 })).toEqual({
      value: 70,
      basis: 'am'
    })
    expect(trendWeight({ date: 'd', legacyWeightKg: 84 })).toEqual({ value: 84, basis: 'legacy' })
    expect(trendWeight({ date: 'd', weightPmKg: 71 })).toEqual({ basis: '' })
  })

  it('睡前重不参与趋势序列，只单独列出', () => {
    const { series, eveningOnlyDates } = buildWeightSeries([
      { date: '2026-10-10', weightPmKg: 72 },
      { date: '2026-10-11', weightAmKg: 70.8, weightPmKg: 71.7 }
    ])
    expect(series).toEqual({ '2026-10-11': 70.8 })
    expect(eveningOnlyDates).toEqual(['2026-10-10'])
  })

  it('某个值为空时不会拿别天的值顶替', () => {
    const { series } = buildWeightSeries([
      { date: '2026-10-11', weightAmKg: 70.8 },
      { date: '2026-10-12' }
    ])
    expect(series['2026-10-12']).toBeUndefined()
  })
})

describe('均线与净流失', () => {
  it('窗口含首尾，只统计窗口内真实存在的日期（缺失不补零）', () => {
    const series = { '2026-10-11': 70.8, '2026-10-12': 70.9, '2026-10-13': 70 }
    expect(movingAverage(series, '2026-10-13', 7)).toBeCloseTo((70.8 + 70.9 + 70) / 3, 6)
    expect(movingAverage(series, '2026-10-12', 2)).toBeCloseTo((70.8 + 70.9) / 2, 6)
    expect(movingAverage(series, '2026-10-11', 7)).toBeCloseTo(70.8, 6)
    expect(movingAverage(series, '2026-10-20', 2)).toBeUndefined()
  })

  it('最新均线取最后一个日期', () => {
    const series = { '2026-10-11': 70.8, '2026-10-13': 70 }
    expect(latestMovingAverage(series, 7)).toBeCloseTo((70.8 + 70) / 2, 6)
    expect(latestMovingAverage({}, 7)).toBeUndefined()
  })

  it('夜间净流失缺任一侧都留空', () => {
    expect(overnightLoss(70, 71.6)).toBeCloseTo(-1.6, 6)
    expect(overnightLoss(70, undefined)).toBeUndefined()
    expect(overnightLoss(undefined, 71.6)).toBeUndefined()
  })

  it('前一天日期', () => {
    expect(previousDate('2026-10-13')).toBe('2026-10-12')
    expect(previousDate('2026-03-01')).toBe('2026-02-28')
  })
})

describe('区间变化率', () => {
  it('按首末有效值算，跨度按天周化', () => {
    const series = { '2026-10-11': 70.8, '2026-10-13': 70 }
    const change = weightChange(series, ['2026-10-11', '2026-10-12', '2026-10-13'])
    expect(change?.first).toBe(70.8)
    expect(change?.changeKg).toBeCloseTo(-0.8, 6)
    expect(change?.spanDays).toBe(2)
    expect(change?.perWeekKg).toBeCloseTo(-2.8, 6)
    expect(change?.pctPerWeek).toBeCloseTo((-2.8 / 70.8) * 100, 6)
  })

  it('不足两天有效值时不外推', () => {
    expect(weightChange({ '2026-10-13': 70 }, ['2026-10-13'])).toBeUndefined()
  })
})

describe('有氧消耗用的体重', () => {
  it('当天没有就用最近一次有效晨重，并说明用的是哪天的', () => {
    const series = { '2026-10-11': 70.8, '2026-10-13': 70 }
    expect(resolveBodyWeight(series, '2026-10-13')).toEqual({ weightKg: 70, from: '2026-10-13' })
    expect(resolveBodyWeight(series, '2026-10-12')).toEqual({ weightKg: 70.8, from: '2026-10-11' })
  })

  it('全部缺失时返回 undefined，由调用方留空并提示', () => {
    expect(resolveBodyWeight({}, '2026-10-13')).toBeUndefined()
    expect(resolveBodyWeight({ '2026-10-20': 70 }, '2026-10-13')).toBeUndefined()
  })
})

