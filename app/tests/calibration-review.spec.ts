// @vitest-environment node
/**
 * 校准复核（T3.5 / §6.7）。
 *
 * 守四件事：**门禁在本地**（样本 / 频率 / 幅度，模型说什么都不放行超限的幅度）、
 * **拦下就归零**（作废的建议不该留在结构化字段里等人读）、**数字守卫与报告同源**、
 * **向导不落库**（只有用户采纳才走 `applyCalibration`）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { buildCalibrationReviewInput, reviewCalibration } from '@/application/calibration'
import { addDays } from '@/app/date'
import { db } from '@/data/db'
import { addIntake } from '@/data/repositories/intake'
import { updateDay } from '@/data/repositories/days'
import { applyCalibration, getTargets, listCalibrations, putTargets } from '@/data/repositories/targets'
import {
  applyCalibrationReviewGates,
  CALIBRATION_MIN_DAYS,
  flagCalibrationNumbers,
  localProposalOf,
  type CalibrationReviewContent,
  type CalibrationReviewInput
} from '@/domain/calibrationReview'
import { chatOk, stubFetch } from './helpers/llm'
import type { ModelConfigRecord } from '@/domain/types'

const END = '2026-10-15'

function reviewInput(patch: Partial<CalibrationReviewInput> = {}): CalibrationReviewInput {
  return {
    date: END,
    window: { label: '近 28 天', start: '2026-09-18', end: END, days: 28 },
    weight: { ma7: 74.6, changeKg: -1.2, changePctPerWeek: -0.4, sampleDays: 16 },
    intake: { avgKcal: 1900, target: 2100, recordedDays: 16, ratio: 0.57, kcalHitDays: 6, proteinHitDays: 4 },
    tdee: { value: 2570, sampleDays: 16, confidence: '可用' },
    currentTargets: { kcalTarget: 2100, proteinTargetG: 150, targetRateKgPerWeek: -0.39 },
    localProposal: { kcalTarget: 2150, deltaKcal: 50, clamped: false },
    ...patch
  }
}

function content(patch: Partial<CalibrationReviewContent> = {}): CalibrationReviewContent {
  return {
    recommended: true,
    deltaKcal: -100,
    direction: '下调',
    confidence: 'medium',
    rationale: '近 4 周体重缓慢下降，建议下调 100 kcal。',
    watchItems: ['盯住体重均线'],
    ...patch
  }
}

describe('门禁：样本 / 频率 / 幅度（FR-904 / FR-905 / FR-707 / FR-708）', () => {
  it('样本足够、频率合适、幅度合理时放行', () => {
    const outcome = applyCalibrationReviewGates(content(), reviewInput())
    expect(outcome.blocked).toBe(false)
    expect(outcome.notices).toEqual([])
    expect(outcome.content.deltaKcal).toBe(-100)
  })

  it('TDEE 样本不足 → 拦下并归零', () => {
    const outcome = applyCalibrationReviewGates(content(), reviewInput({ tdee: undefined }))
    expect(outcome.blocked).toBe(true)
    expect(outcome.content.recommended).toBe(false)
    expect(outcome.content.deltaKcal).toBe(0)
    expect(outcome.content.direction).toBe('不变')
    expect(outcome.notices.join()).toContain('样本')
  })

  it('覆盖率不到一半 → 拦下', () => {
    const input = reviewInput()
    input.intake = { ...input.intake, recordedDays: 8, ratio: 0.29 }
    const outcome = applyCalibrationReviewGates(content(), input)
    expect(outcome.blocked).toBe(true)
    expect(outcome.notices.join()).toContain('8 天')
  })

  it(`距上次校准不足 ${CALIBRATION_MIN_DAYS} 天 → 拦下（FR-905）`, () => {
    const outcome = applyCalibrationReviewGates(
      content(),
      reviewInput({ lastCalibration: { date: '2026-10-10', deltaKcal: 50, daysSince: 5 } })
    )
    expect(outcome.blocked).toBe(true)
    expect(outcome.notices.join()).toContain('再观察')
  })

  it('幅度超过 ±150 kcal → 拦下（模型回一个 −400 也进不了采纳）', () => {
    const outcome = applyCalibrationReviewGates(content({ deltaKcal: -400 }), reviewInput())
    expect(outcome.blocked).toBe(true)
    expect(outcome.content.deltaKcal).toBe(0)
    expect(outcome.notices.join()).toContain('±150')
  })

  it('说「建议调整」却给 0 幅度 → 当成不建议调整（不留空行动项）', () => {
    const outcome = applyCalibrationReviewGates(content({ deltaKcal: 0, direction: '不变' }), reviewInput())
    expect(outcome.blocked).toBe(false)
    expect(outcome.content.recommended).toBe(false)
    expect(outcome.notices.join()).toContain('幅度是 0')
  })

  it('方向与幅度不一致 → 以幅度为准（数字是硬事实，词不是）', () => {
    const outcome = applyCalibrationReviewGates(content({ deltaKcal: -100, direction: '上调' }), reviewInput())
    expect(outcome.content.direction).toBe('下调')
    expect(outcome.notices.join()).toContain('不一致')
  })
})

describe('数字守卫与本地建议', () => {
  it('白名单来自输入：引用本地数字不算编造', () => {
    expect(
      flagCalibrationNumbers(content({ rationale: '当前目标 2100 kcal，实测 2570 kcal。' }), reviewInput())
    ).toEqual([])
  })

  it('编出来的数字被标出来', () => {
    expect(flagCalibrationNumbers(content({ rationale: '照这样 6 周能到 68 kg。' }), reviewInput())).toEqual(['68'])
  })

  it('本地建议与目标页同一口径；没有 TDEE 就不给建议', () => {
    const proposal = localProposalOf(reviewInput())
    // 2570 + (-0.39 × 7700 / 7) = 2141 → 取 50 的整数倍 → 2150
    expect(proposal?.kcalTarget).toBe(2150)
    expect(proposal?.deltaKcal).toBe(50)
    expect(proposal?.clamped).toBe(false)
    expect(localProposalOf(reviewInput({ tdee: undefined }))).toBeUndefined()
  })
})

describe('用例层：组装输入与 AI 复核', () => {
  function config(patch: Partial<ModelConfigRecord> = {}): ModelConfigRecord {
    return {
      id: 'current',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      timeoutMs: 1000,
      enabled: true,
      updatedAt: Date.now(),
      ...patch
    }
  }

  const run = { config: config(), sleep: async () => undefined, retryDelayMs: 0, skipLog: true }

  async function seedDay(date: string, weightKg: number, kcal: number): Promise<void> {
    await updateDay(date, { weightAmKg: weightKg })
    await addIntake({
      date,
      meal: '午餐',
      dish: '测试餐',
      foodId: '测试食材',
      foodSnapshot: {
        name: '测试食材',
        unit: '100g',
        kcal,
        proteinG: 80,
        fatG: 40,
        carbG: 100,
        fiberG: 10,
        sodiumMg: 1000
      },
      amount: { qty: 1, unit: '100g', grams: 100 },
      computed: { kcal, proteinG: 80, fatG: 40, carbG: 100, fiberG: 10, sodiumMg: 1000 }
    })
  }

  /** 16 天记录（体重缓慢下降 + 每天 1800 kcal）：覆盖率 16/28 > 50%，TDEE 样本 16 天。 */
  async function seedWeeks(): Promise<void> {
    for (let index = 0; index < 16; index += 1) {
      await seedDay(addDays('2026-09-30', index), 76 - index * 0.1, 1800)
    }
  }

  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map((table) => table.clear()))
    await putTargets({
      tdeeKcal: 2600,
      kcalTarget: 2100,
      proteinTargetG: 150,
      fatTargetG: 70,
      carbTargetG: 270,
      fiberTargetG: 30,
      sodiumMaxMg: 2000,
      weeklyTrainingDays: 3,
      weeklySetsPerMuscle: 10,
      targetWeightKg: 65,
      targetRateKgPerWeek: -0.39,
      reviewCadence: 'weekly'
    })
  })

  it('输入按自然日铺满 28 天，覆盖率的分母是区间天数', async () => {
    await seedWeeks()
    const input = await buildCalibrationReviewInput(END)

    expect(input.window.days).toBe(28)
    expect(input.window.start).toBe('2026-09-18')
    expect(input.intake.recordedDays).toBe(16)
    // 16 / 28 = 57.14% → round1 → 57.1% → 0.571（报告同一套 round1 口径）
    expect(input.intake.ratio).toBeCloseTo(0.571, 3)
    expect(input.tdee?.sampleDays).toBe(16)
    expect(input.localProposal.deltaKcal).not.toBe(0)
  })

  it('生成复核：通过门禁后返回内容与模型信息，且**不落库**', async () => {
    await seedWeeks()
    const input = await buildCalibrationReviewInput(END)
    const before = await listCalibrations()

    const { fetchImpl } = stubFetch([chatOk(JSON.stringify(content()))])
    const outcome = await reviewCalibration(input, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(true)
    expect(outcome.blocked).toBe(false)
    expect(outcome.content?.deltaKcal).toBe(-100)
    expect(outcome.model).toBe('test-model')
    expect(outcome.taskVersion).toBe(1)

    // 向导本身不写任何东西 —— 只有用户点「采纳」才写
    expect(await listCalibrations()).toEqual(before)
    expect((await getTargets())?.kcalTarget).toBe(2100)
  })

  it('模型给了超限幅度：做一次复核会被门禁拦下（FR-904）', async () => {
    await seedWeeks()
    const input = await buildCalibrationReviewInput(END)
    const { fetchImpl } = stubFetch([chatOk(JSON.stringify(content({ deltaKcal: -400 })))])
    const outcome = await reviewCalibration(input, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(true)
    expect(outcome.blocked).toBe(true)
    expect(outcome.content?.deltaKcal).toBe(0)
    expect(outcome.notices.join()).toContain('±150')
  })

  it('模型失败：不落库，本地建议照常可用', async () => {
    await seedWeeks()
    const input = await buildCalibrationReviewInput(END)
    const { fetchImpl } = stubFetch([new Error('offline'), new Error('offline')])
    const outcome = await reviewCalibration(input, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.retriable).toBe(true)
    expect(outcome.content).toBeUndefined()
    expect(outcome.local?.kcalTarget).toBeGreaterThan(0)
    expect(await listCalibrations()).toEqual([])
  })

  it('采纳走 applyCalibration：目标更新且留下校准记录', async () => {
    await seedWeeks()
    const input = await buildCalibrationReviewInput(END)
    const measured = input.tdee?.value ?? 0

    await applyCalibration({
      date: END,
      measuredTdee: measured,
      kcalAfter: input.currentTargets.kcalTarget - 100,
      basis: 'AI 复核：测试'
    })

    const targets = await getTargets()
    expect(targets?.kcalTarget).toBe(2000)
    expect(targets?.lastCalibrated).toBe(END)
    const records = await listCalibrations()
    expect(records).toHaveLength(1)
    expect(records[0].kcalBefore).toBe(2100)
    expect(records[0].kcalAfter).toBe(2000)
  })
})
