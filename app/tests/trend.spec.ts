// @vitest-environment node
/**
 * 对拍：趋势页的区间聚合 `domain/trend.ts`（T1.6 / M6 FR-600）。
 *
 * 期望值来自 `python scripts/nutrition.py trend --days 14`（docs/pwa-design.md §5.3）：
 * 逐日表（晨重 / 睡前 / 夜间净流失 / 7 日均线 / 摄入 / 训练）、区间小结（体重变化率、
 * 达标率、训练量、肌群组数）与训练明细（动作容量）逐项比对。
 *
 * 区间聚合是页面与报告摘要共用的口径，所以这里比对的是脚本的**数值与结论**，
 * 界面文案不参与比对（UI 只做展示）。
 */

import { describe, expect, it } from 'vitest'
import { buildTrend, MA_WINDOW, normalizeTrendWindow, TREND_WINDOWS, type TrendDayInput } from '@/domain/trend'
import { isPlausibleWeight } from '@/domain/weight'
import {
  cellOf,
  expectClose,
  expectMaybeClose,
  expectedBullets,
  expectedLineContaining,
  expectedTable,
  factsOf,
  loadRecordFixtures,
  loadTargetsFixture,
  numbersIn,
  numberOf,
  toIntakeEntries,
  toWorkoutEntries
} from './helpers/fixtures'

const EXPECTED = 'expected-trend.txt'
const records = loadRecordFixtures()
const targets = { ...loadTargetsFixture(), weeklySetsPerMuscle: 10 }

const days: TrendDayInput[] = records.map((record) => ({
  date: record.date,
  weightAmKg: record.weightAmKg,
  weightPmKg: record.weightPmKg,
  legacyWeightKg: record.legacyWeightKg,
  intake: factsOf(toIntakeEntries(record).map((entry) => entry.computed)),
  hasIntakeRows: record.intake.length > 0,
  workouts: toWorkoutEntries(record)
}))

const trend = buildTrend({ days, targets, maWindow: MA_WINDOW })
const table = expectedTable(EXPECTED, ['日期', '晨重', '均线'])

describe('对拍 trend：逐日表', () => {
  it('行数与窗口一致', () => {
    expect(trend.rows.map((row) => row.date)).toEqual(days.map((day) => day.date))
    expect(trend.start).toBe('2026-10-09')
    expect(trend.end).toBe('2026-10-13')
  })

  it.each(days.map((day) => day.date))('%s 的体重 / 均线 / 摄入 / 训练与脚本一致', (date) => {
    const row = table.rows.find((item) => cellOf(table, item, '日期') === date)
    if (!row) throw new Error(`期望表缺少 ${date}`)
    const actual = trend.rows.find((item) => item.date === date)
    if (!actual) throw new Error(`区间聚合缺少 ${date}`)
    expectMaybeClose(actual.weightAmKg, numberOf(table, row, '晨重'), `${date}.晨重`)
    expectMaybeClose(actual.weightPmKg, numberOf(table, row, '睡前'), `${date}.睡前`)
    expectMaybeClose(actual.overnightKg, numberOf(table, row, '夜间净流失'), `${date}.夜间净流失`)
    expectMaybeClose(actual.ma, numberOf(table, row, '均线'), `${date}.7日均线`)
    expectClose(actual.intake.kcal, numberOf(table, row, '热量'), `${date}.热量`)
    expectClose(actual.intake.proteinG, numberOf(table, row, '蛋白'), `${date}.蛋白`)
    expectClose(actual.intake.fatG, numberOf(table, row, '脂肪'), `${date}.脂肪`)
    expectClose(actual.intake.carbG, numberOf(table, row, '碳水'), `${date}.碳水`)
    expectMaybeClose(actual.minutes || undefined, numberOf(table, row, '训练'), `${date}.训练时长`)
    expectMaybeClose(actual.sets || undefined, numberOf(table, row, '组数'), `${date}.组数`)
  })
})

describe('对拍 trend：区间小结', () => {
  it('体重变化率（首末、差值、周化、百分比）与脚本一致', () => {
    const numbers = numbersIn(expectedLineContaining(EXPECTED, '- 体重：'))
    if (!trend.weight) throw new Error('区间体重数据不足')
    expectClose(trend.weight.first, numbers[0], '首值')
    expectClose(trend.weight.last, numbers[1], '末值')
    expectClose(trend.weight.changeKg, numbers[2], '区间差值')
    expectClose(trend.weight.perWeekKg, numbers[3], '周均')
    expectClose(trend.weight.pctPerWeek, numbers[4], '周均百分比')
  })

  it('最新 7 日均线与脚本一致', () => {
    const numbers = numbersIn(expectedLineContaining(EXPECTED, '- 最新'))
    expect(numbers[0]).toBe(MA_WINDOW)
    expectClose(trend.weight?.latestMa ?? NaN, numbers[1], '最新均线')
  })

  it('日均摄入与有记录天数与脚本一致', () => {
    const numbers = numbersIn(expectedLineContaining(EXPECTED, '- 摄入：'))
    expectClose(trend.intake.avg.kcal, numbers[0], '平均热量')
    expectClose(trend.intake.avg.proteinG, numbers[1], '平均蛋白')
    expect(numbers[2]).toBe(trend.intake.days)
    expect(trend.intake.days).toBe(4)
  })

  it('热量 / 蛋白达标天数与脚本一致（热量 ±10%、蛋白 ≥ 90% 目标）', () => {
    const kcalLine = numbersIn(expectedLineContaining(EXPECTED, '- 热量达标')).slice(-2)
    const proteinLine = numbersIn(expectedLineContaining(EXPECTED, '- 蛋白达标')).slice(-2)
    expect(kcalLine).toEqual([trend.intake.kcalHit.hit, trend.intake.kcalHit.total])
    expect(proteinLine).toEqual([trend.intake.proteinHit.hit, trend.intake.proteinHit.total])
  })

  it('训练天数 / 分钟 / 组数 / 容量负荷与脚本一致', () => {
    const numbers = numbersIn(expectedLineContaining(EXPECTED, '- 训练：'))
    expect(numbers[0]).toBe(trend.training.days)
    expectClose(trend.training.minutes, numbers[1], '合计分钟')
    expect(trend.training.sets).toBe(numbers[2])
    expectClose(trend.training.load, numbers[3], '容量负荷')
  })

  it('各肌群组数与容量与脚本一致', () => {
    expect(trend.training.muscles.map((row) => [row.name, row.sets, row.load])).toEqual([
      ['胸', 3, 384],
      ['背', 3, 384],
      ['腿', 3, 384],
      ['核心', 3, 0]
    ])
    const line = expectedLineContaining(EXPECTED, '- 各肌群组数')
    expect(line).toContain('胸 3 组（容量 384 kg）')
    // 自重动作不计容量，脚本那行不给容量后缀
    expect(line).toContain('核心 3 组')
  })

  it('区间不足 7 天时不外推周均（FR-606）', () => {
    expect(trend.training.weeklyExtrapolated).toBe(false)
    expect(trend.training.perWeekDays).toBeUndefined()
    expect(trend.training.muscles.every((row) => row.perWeekSets === undefined)).toBe(true)
  })
})

describe('对拍 trend：训练明细（容量负荷）', () => {
  it('动作的出现次数 / 组数 / 最近一次写法 / 区间容量与脚本一致', () => {
    const detail = expectedTable(EXPECTED, ['动作', '区间容量'])
    expect(trend.moves).toHaveLength(detail.rows.length)
    detail.rows.forEach((row, index) => {
      const [name, item] = trend.moves[index]
      expect(cellOf(detail, row, '动作')).toBe(name)
      expect(cellOf(detail, row, '目标肌群')).toBe(item.muscles)
      expect(numberOf(detail, row, '出现')).toBe(item.dates.length)
      expect(numberOf(detail, row, '组数')).toBe(item.sets)
      expect(cellOf(detail, row, '最近一次')).toBe(item.volume)
      // 自重动作（如平板支撑）脚本给的是 `-`，容量按 0 记
      expectClose(item.load, numberOf(detail, row, '区间容量') ?? 0, `${name}.区间容量`)
    })
  })
})

describe('对拍 trend：样本标注与空状态', () => {
  it('只有睡前体重的日期被单列出来，且不进入均线与 TDEE（FR-607 / DR-08）', () => {
    const note = expectedBullets(EXPECTED).find((line) => line.startsWith('只有睡前体重的日期'))
    expect(note).toBeDefined()
    expect(trend.notes).toContain(note)
    expect(trend.rows.find((row) => row.date === '2026-10-10')?.weightAmKg).toBeUndefined()
    expect(trend.coverage.daysEveningOnly).toBe(1)
    // 睡前重不得进均线
    expect(trend.rows.find((row) => row.date === '2026-10-10')?.ma).toBeUndefined()
    expect(trend.coverage.daysWithWeight).toBe(3)
  })

  it('覆盖率显示区间内记录到的天数（FR-608）', () => {
    expect(trend.coverage).toMatchObject({
      days: 5,
      daysWithIntake: 4,
      daysWithTraining: 1,
      daysWithLegacyWeight: 0
    })
    expectClose(trend.coverage.intakeRatio * 100, 80, '摄入覆盖率')
  })

  it('区间内完全没有记录时是「未记录」而不是 0（FR-607）', () => {
    const empty = buildTrend({
      days: [{ date: '2026-10-14', intake: factsOf([]), hasIntakeRows: false, workouts: [] }],
      targets
    })
    expect(empty.empty).toBe(true)
    expect(empty.intake.days).toBe(0)
  })

  it('窗口只接受 7 / 14 / 28，非法值退回 7（FR-606）', () => {
    expect(TREND_WINDOWS).toEqual([7, 14, 28])
    expect(normalizeTrendWindow('14')).toBe(14)
    expect(normalizeTrendWindow(28)).toBe(28)
    expect(normalizeTrendWindow('30')).toBe(7)
    expect(normalizeTrendWindow(undefined)).toBe(7)
  })

  it('口径不明的旧字段体重只作兜底并单独标注（DR-10）', () => {
    const legacyDay: TrendDayInput = {
      date: '2026-10-14',
      legacyWeightKg: 70,
      intake: factsOf([]),
      hasIntakeRows: false,
      workouts: []
    }
    const result = buildTrend({ days: [legacyDay], targets })
    expect(result.rows[0].basis).toBe('legacy')
    expect(isPlausibleWeight(result.rows[0].weightKg)).toBe(true)
    expect(result.notes.some((note) => note.includes('weight_kg'))).toBe(true)
    expect(result.coverage.daysWithLegacyWeight).toBe(1)
  })
})
