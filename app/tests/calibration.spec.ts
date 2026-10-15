// @vitest-environment node
/**
 * 对拍：`python scripts/nutrition.py init`（docs/pwa-design.md §5.3 / §5.1 calibration）。
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_CALIBRATION_KCAL,
  activityFactor,
  buildInitialTargets,
  classifyGoal,
  inferWeeklySetsPerMuscle,
  inferWeeklyTrainingDays,
  kcalForRate,
  mifflinStJeorBmr,
  proposeCalibration,
  pyRound,
  resolveSeedWeight
} from '@/domain/calibration'
import { expectClose, expectedTable, loadProfileFixture, loadTargetsFixture, numberOf } from './helpers/fixtures'

const profile = loadProfileFixture()

describe('对拍 init：首次估算', () => {
  const table = expectedTable('expected-init.txt', ['项目', '数值'])
  const row = (prefix: string) => {
    const found = table.rows.find((item) => (item[0] ?? '').startsWith(prefix))
    if (!found) throw new Error(`期望表缺少以「${prefix}」开头的行`)
    return found
  }

  // 脚本的 init 只认记录里的旧字段 weight_kg；fixtures 里的记录都用 weight_am_kg，
  // 因此它退回了 profile.md 的 75 kg。这里显式传同样的体重，才能逐项对拍。
  const targets = buildInitialTargets({
    profile: {
      sex: 'male',
      age: 30,
      heightCm: 175,
      goal: '减脂',
      trainingLevel: '新手'
    },
    weightKg: 75,
    weeklyTrainingDays: 3
  })

  it('输入取自 profile.md / targets.md 的 front-matter', () => {
    expect(profile.sex).toBe('male')
    expect(profile.age).toBe('30')
    expect(profile.height_cm).toBe('175')
    expect(loadTargetsFixture().kcalTarget).toBe(2240)
  })

  it('BMR / TDEE / 活动系数与脚本一致', () => {
    expect(mifflinStJeorBmr({ sex: 'male', weightKg: 75, heightCm: 175, age: 30 })).toBeCloseTo(1698.75, 6)
    expectClose(targets.bmr, numberOf(table, row('基础代谢'), '数值'), 'BMR')
    expectClose(targets.tdeeKcal, numberOf(table, row('TDEE'), '数值'), 'TDEE')
    expectClose(targets.tdeeKcal / targets.bmr, numberOf(table, row('活动系数'), '数值'), '活动系数')
  })

  it('热量目标 / 蛋白 / 脂肪 / 碳水与脚本一致，且与 targets.md 现状相同', () => {
    expectClose(targets.kcalTarget, numberOf(table, row('热量目标'), '数值'), '热量目标')
    expectClose(targets.proteinTargetG, numberOf(table, row('蛋白质'), '数值'), '蛋白质')
    expectClose(targets.fatTargetG, numberOf(table, row('脂肪'), '数值'), '脂肪')
    expectClose(targets.carbTargetG, numberOf(table, row('碳水'), '数值'), '碳水')
    expect(targets.kcalTarget).toBe(2240)
    expect(targets.proteinTargetG).toBe(150)
    expect(targets.fatTargetG).toBe(60)
    expect(targets.carbTargetG).toBe(275)
  })

  it('阶段、目标速率与训练参数与脚本一致', () => {
    expect(targets.phase).toBe('减脂')
    expectClose(targets.targetRateKgPerWeek, numberOf(table, row('目标速率'), '数值'), '目标速率')
    expect(targets.targetRateKgPerWeek).toBeCloseTo(-0.36, 2)
    expect(targets.weeklyTrainingDays).toBe(3)
    expect(targets.weeklySetsPerMuscle).toBe(10)
  })

  it('front-matter 建议值与脚本一致', () => {
    expect(Math.round(targets.tdeeKcal)).toBe(2633)
  })
})

describe('BMR 与活动系数', () => {
  it('女性公式常数不同', () => {
    expect(mifflinStJeorBmr({ sex: 'female', weightKg: 60, heightCm: 165, age: 30 })).toBeCloseTo(
      10 * 60 + 6.25 * 165 - 5 * 30 - 161,
      6
    )
  })

  it('活动系数分档与脚本一致', () => {
    expect(activityFactor(0).factor).toBe(1.2)
    expect(activityFactor(2).factor).toBe(1.375)
    expect(activityFactor(3).factor).toBe(1.55)
    expect(activityFactor(4).factor).toBe(1.55)
    expect(activityFactor(6).factor).toBe(1.725)
    expect(activityFactor(7).factor).toBe(1.9)
  })

  it('目标文本判定阶段与调整幅度', () => {
    expect(classifyGoal('减脂')).toEqual({ phase: '减脂', adjust: -0.15 })
    expect(classifyGoal('减脂同时增肌')).toEqual({ phase: '重组', adjust: -0.1 })
    expect(classifyGoal('增肌')).toEqual({ phase: '增肌', adjust: 0.1 })
    expect(classifyGoal('')).toEqual({ phase: '维持', adjust: 0 })
  })

  it('训练水平推定每周天数与每肌群组数', () => {
    expect(inferWeeklyTrainingDays('新手')).toBe(3)
    expect(inferWeeklyTrainingDays('中级')).toBe(4)
    expect(inferWeeklyTrainingDays('高级')).toBe(5)
    expect(inferWeeklySetsPerMuscle('新手')).toBe(10)
    expect(inferWeeklySetsPerMuscle('高级')).toBe(18)
  })
})

describe('python round 语义', () => {
  it('半偶数进位，保证与脚本的整数目标不漂移', () => {
    expect(pyRound(0.5)).toBe(0)
    expect(pyRound(1.5)).toBe(2)
    expect(pyRound(2.5)).toBe(2)
    expect(pyRound(241.9258)).toBe(242)
    expect(pyRound(-38.744)).toBe(-39)
  })
})

describe('校准门禁', () => {
  it('幅度在 ±150 kcal 内直接采纳', () => {
    // 实测 TDEE 2540 +（速率 -0.4 → -440 kcal/天）= 2100，正好等于当前目标
    const proposal = proposeCalibration(2540, 2100, -0.4)
    expect(proposal.clamped).toBe(false)
    expect(proposal.kcalTarget).toBe(2100)
    expect(proposal.deltaKcal).toBeLessThanOrEqual(MAX_CALIBRATION_KCAL)
  })

  it('单次调整超过上限时被拦下并说明', () => {
    const proposal = proposeCalibration(3600, 2100, -0.1)
    expect(proposal.clamped).toBe(true)
    expect(Math.abs(proposal.deltaKcal)).toBeLessThanOrEqual(MAX_CALIBRATION_KCAL)
    expect(proposal.note).toContain(`±${MAX_CALIBRATION_KCAL}`)
  })

  it('目标速率对应热量', () => {
    expect(kcalForRate(2870, -0.5)).toBeCloseTo(2320, 6)
  })
})

describe('首次估算用哪个体重', () => {
  it('优先最近一次真实称重，其次 profile.md', () => {
    expect(
      resolveSeedWeight([{ date: '2026-10-11', weightAmKg: 70.8 }, { date: '2026-10-13', weightAmKg: 70 }], 73)
    ).toEqual({ weightKg: 70, from: '最近记录 2026-10-13' })
    expect(resolveSeedWeight([{ date: '2026-10-13', weightPmKg: 71 }], 73)).toEqual({
      weightKg: 71,
      from: '最近记录 2026-10-13（睡前重）'
    })
    expect(resolveSeedWeight([{ date: '2026-10-13' }], 73)).toEqual({ weightKg: 73, from: 'profile.md' })
    expect(resolveSeedWeight([], undefined)).toEqual({ from: '' })
  })
})

