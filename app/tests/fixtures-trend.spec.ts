// @vitest-environment node
/**
 * 对拍：`python scripts/nutrition.py trend --days 14`（docs/pwa-design.md §5.3 T1.2 / T1.3）。
 *
 * 覆盖逐日表（晨重 / 睡前 / 夜间净流失 / 7 日均线 / 摄入 / 训练）、
 * 区间小结（体重变化率、达标率、训练量）与训练明细（容量负荷、渐进超负荷）。
 */

import { describe, expect, it } from 'vitest'
import { aggregateWorkouts, rankMoves } from '@/domain/training'
import { kcalHit, proteinHit } from '@/domain/adherence'
import {
  buildWeightSeries,
  latestMovingAverage,
  movingAverage,
  overnightLoss,
  previousDate,
  weightChange
} from '@/domain/weight'
import {
  cellOf,
  expectClose,
  expectMaybeClose,
  expectedLineContaining,
  expectedTable,
  loadRecordFixtures,
  loadTargetsFixture,
  numbersIn,
  numberOf,
  toWorkoutEntries
} from './helpers/fixtures'

const EXPECTED_FILE = 'expected-trend.txt'
const records = loadRecordFixtures()
const targets = loadTargetsFixture()

const weightLikes = records.map((record) => ({
  date: record.date,
  weightAmKg: record.weightAmKg,
  weightPmKg: record.weightPmKg,
  legacyWeightKg: record.legacyWeightKg
}))
const { series } = buildWeightSeries(weightLikes)
const dates = records.map((record) => record.date)

const table = expectedTable(EXPECTED_FILE, ['日期', '晨重', '均线'])

interface Facts {
  kcal: number
  proteinG: number
  fatG: number
  carbG: number
  fiberG: number
  sodiumMg: number
}

function intakeOf(date: string): Facts {
  const record = records.find((item) => item.date === date)
  if (!record) throw new Error(`缺少 ${date}`)
  return record.intake.reduce<Facts>(
    (total, row) => ({
      kcal: total.kcal + row.facts.kcal,
      proteinG: total.proteinG + row.facts.proteinG,
      fatG: total.fatG + row.facts.fatG,
      carbG: total.carbG + row.facts.carbG,
      fiberG: total.fiberG + row.facts.fiberG,
      sodiumMg: total.sodiumMg + row.facts.sodiumMg
    }),
    { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 }
  )
}

function trainingOf(date: string) {
  const record = records.find((item) => item.date === date)
  if (!record) throw new Error(`缺少 ${date}`)
  return aggregateWorkouts(toWorkoutEntries(record))
}

function eveningOf(date: string): number | undefined {
  return records.find((item) => item.date === date)?.weightPmKg
}

describe('对拍 trend：逐日表', () => {
  it('行数与日期与脚本一致', () => {
    expect(table.rows.map((row) => cellOf(table, row, '日期'))).toEqual(dates)
  })

  it.each(dates)('%s 的体重 / 均线 / 摄入 / 训练与脚本一致', (date) => {
    const row = table.rows.find((item) => cellOf(table, item, '日期') === date)
    if (!row) throw new Error(`期望表缺少 ${date}`)
    const intake = intakeOf(date)
    const training = trainingOf(date)

    expectMaybeClose(series[date], numberOf(table, row, '晨重'), `${date}.晨重`)
    expectMaybeClose(eveningOf(date), numberOf(table, row, '睡前'), `${date}.睡前`)
    expectMaybeClose(
      overnightLoss(series[date], eveningOf(previousDate(date))),
      numberOf(table, row, '夜间净流失'),
      `${date}.夜间净流失`
    )
    expectMaybeClose(movingAverage(series, date, 7), numberOf(table, row, '均线'), `${date}.7日均线`)
    expectClose(intake.kcal, numberOf(table, row, '热量'), `${date}.热量`)
    expectClose(intake.proteinG, numberOf(table, row, '蛋白'), `${date}.蛋白`)
    expectClose(intake.fatG, numberOf(table, row, '脂肪'), `${date}.脂肪`)
    expectClose(intake.carbG, numberOf(table, row, '碳水'), `${date}.碳水`)
    expectMaybeClose(training.minutes || undefined, numberOf(table, row, '训练'), `${date}.训练时长`)
    expectMaybeClose(training.sets || undefined, numberOf(table, row, '组数'), `${date}.组数`)
  })
})

describe('对拍 trend：区间小结', () => {
  const intakeDays = records.filter((record) => record.intake.length > 0)
  const trainingDays = records.filter((record) => record.training.length > 0)

  it('体重变化率（首末、差值、周化、百分比）与脚本一致', () => {
    const change = weightChange(series, dates)
    if (!change) throw new Error('fixture 体重数据不足')
    const numbers = numbersIn(expectedLineContaining(EXPECTED_FILE, '- 体重：'))
    expectClose(change.first, numbers[0], '首值')
    expectClose(change.last, numbers[1], '末值')
    expectClose(change.changeKg, numbers[2], '区间差值')
    expectClose(change.perWeekKg, numbers[3], '周均')
    expectClose(change.pctPerWeek, numbers[4], '周均百分比')
  })

  it('最新 7 日均线与脚本一致', () => {
    const numbers = numbersIn(expectedLineContaining(EXPECTED_FILE, '- 最新'))
    // 「最新 7 日均线：75.4 kg」里的 7 是窗口天数，数值在它后面
    expect(numbers[0]).toBe(7)
    expectClose(latestMovingAverage(series, 7) ?? NaN, numbers[1], '最新均线')
  })

  it('平均摄入与有记录天数与脚本一致', () => {
    const numbers = numbersIn(expectedLineContaining(EXPECTED_FILE, '- 摄入：'))
    const avgKcal = intakeDays.reduce((sum, day) => sum + intakeOf(day.date).kcal, 0) / intakeDays.length
    const avgProtein =
      intakeDays.reduce((sum, day) => sum + intakeOf(day.date).proteinG, 0) / intakeDays.length
    expectClose(avgKcal, numbers[0], '平均热量')
    expectClose(avgProtein, numbers[1], '平均蛋白')
    expect(numbers[2]).toBe(intakeDays.length)
  })

  it('热量 / 蛋白达标天数与脚本一致（热量 ±10%、蛋白 ≥ 90% 目标）', () => {
    // 行内还有「±10%」和「90%」这类阈值数字，取末尾的「命中 / 总数」
    const kcalLine = numbersIn(expectedLineContaining(EXPECTED_FILE, '- 热量达标')).slice(-2)
    const proteinLine = numbersIn(expectedLineContaining(EXPECTED_FILE, '- 蛋白达标')).slice(-2)
    const kcalHits = intakeDays.filter((day) => kcalHit(intakeOf(day.date).kcal, targets.kcalTarget)).length
    const proteinHits = intakeDays.filter((day) =>
      proteinHit(intakeOf(day.date).proteinG, targets.proteinTargetG)
    ).length
    expect(kcalHits).toBe(kcalLine[0])
    expect(kcalLine[1]).toBe(intakeDays.length)
    expect(proteinHits).toBe(proteinLine[0])
    expect(proteinLine[1]).toBe(intakeDays.length)
  })

  it('训练天数 / 分钟 / 组数 / 容量负荷与脚本一致', () => {
    const numbers = numbersIn(expectedLineContaining(EXPECTED_FILE, '- 训练：'))
    const aggregates = trainingDays.map((day) => trainingOf(day.date))
    expect(numbers[0]).toBe(trainingDays.length)
    expectClose(
      aggregates.reduce((sum, item) => sum + item.minutes, 0),
      numbers[1],
      '合计分钟'
    )
    expect(aggregates.reduce((sum, item) => sum + item.sets, 0)).toBe(numbers[2])
    expectClose(
      aggregates.reduce((sum, item) => sum + item.load, 0),
      numbers[3],
      '容量负荷'
    )
  })

  it('各肌群组数与容量与脚本一致', () => {
    const aggregates = trainingDays.map((day) => trainingOf(day.date))
    const muscles: Record<string, number> = {}
    const muscleLoad: Record<string, number> = {}
    for (const item of aggregates) {
      for (const [name, sets] of Object.entries(item.muscles)) muscles[name] = (muscles[name] ?? 0) + sets
      for (const [name, load] of Object.entries(item.muscleLoad)) {
        muscleLoad[name] = (muscleLoad[name] ?? 0) + load
      }
    }
    expect(muscles).toEqual({ 胸: 3, 背: 3, 腿: 3, 核心: 3 })
    // 自重动作（平板支撑）不计容量
    expect(muscleLoad).toEqual({ 胸: 384, 背: 384, 腿: 384 })
    const line = expectedLineContaining(EXPECTED_FILE, '- 各肌群组数')
    expect(line).toContain('胸 3 组（容量 384 kg）')
    expect(line).toContain('核心 3 组')
  })
})

describe('对拍 trend：训练明细（容量负荷）', () => {
  it('动作的出现次数 / 组数 / 最近一次写法 / 区间容量与脚本一致', () => {
    const detail = expectedTable(EXPECTED_FILE, ['动作', '区间容量'])
    const entries = records.flatMap((record) => toWorkoutEntries(record))
    const moves = rankMoves(aggregateWorkouts(entries).moves)
    expect(detail.rows).toHaveLength(moves.length)
    detail.rows.forEach((row, index) => {
      const [name, item] = moves[index]
      expect(cellOf(detail, row, '动作')).toBe(name)
      expect(cellOf(detail, row, '目标肌群')).toBe(item.muscles)
      expect(numberOf(detail, row, '出现')).toBe(item.dates.length)
      expect(numberOf(detail, row, '组数')).toBe(item.sets)
      expect(cellOf(detail, row, '最近一次')).toBe(item.volume)
      // 自重动作（平板支撑）脚本给的是 `-`，容量按 0 记
      expectClose(item.load, numberOf(detail, row, '区间容量') ?? 0, `${name}.区间容量`)
    })
  })

  it('自重动作不计容量负荷', () => {
    const selfWeight = aggregateWorkouts([
      {
        id: 'x',
        date: '2026-10-13',
        type: '力量',
        muscles: ['胸'],
        exercise: '俯卧撑',
        sets: [{ reps: 15, bodyweight: true }],
        volumeRaw: '3x15x自重'
      }
    ])
    expect(selfWeight.load).toBe(0)
    expect(selfWeight.bodyweightSets).toBe(1)
  })
})
