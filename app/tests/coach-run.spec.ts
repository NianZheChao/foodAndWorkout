// @vitest-environment node
/**
 * 每日指导的用例层（T3.7 / §6.4.2）。
 *
 * 守六条：输入里只有摘要与缺口（没有原始记录）、同日不重复调用、手动刷新覆盖当天那一条、
 * 依据校验与样本门禁真的落地、表态进 `adviceLog` 并成为下一轮 `history.advice`、
 * 模型失败不写任何指导（但本地缺口提示照常给）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildCoachContext,
  COACH_WINDOW_DAYS,
  generateAdvice,
  markAdviceAdopted
} from '@/application/coach'
import { db } from '@/data/db'
import { updateDay } from '@/data/repositories/days'
import { addIntake } from '@/data/repositories/intake'
import { listRecentAdvice } from '@/data/repositories/adviceLog'
import { putTargets } from '@/data/repositories/targets'
import { addWorkout } from '@/data/repositories/workout'
import { chatOk, stubFetch } from './helpers/llm'
import type { CoachAdviceItem, ModelConfigRecord } from '@/domain/types'

const END = '2026-10-15'

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

function coachJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headline: '蛋白偏低，今天先把它补上。',
    advice: [{ kind: 'fact', text: '近 7 天平均蛋白偏低。', basis: ['intake.avgProteinG'] }],
    focus: ['晚饭先把蛋白补上'],
    ask: ['今天还练不练？'],
    disclaimer: '仅供参考。',
    ...patch
  })
}

async function seedDay(date: string, weightKg: number, kcal?: number, sleepHours?: number): Promise<void> {
  await updateDay(date, { weightAmKg: weightKg, sleepHours })
  if (kcal === undefined) return
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

/** 一周里铺 5 天记录：覆盖率过半，三道门禁都不会误触。 */
async function seedWeek(): Promise<void> {
  await seedDay('2026-10-10', 75.4, 1900, 6.5)
  await seedDay('2026-10-11', 75.1, 1850, 7)
  await seedDay('2026-10-12', 74.8, 1800, 5.5)
  await seedDay('2026-10-13', 74.6, 1750, 6)
  await seedDay(END, 74.4, 1800, 7)
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  await putTargets({
    tdeeKcal: 2633,
    kcalTarget: 2100,
    proteinTargetG: 140,
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

describe('组装指导输入', () => {
  it('窗口是近 7 天滚动，缺口与训练状态都来自本地', async () => {
    await seedWeek()
    await addWorkout({ date: END, type: '拉伸', exercise: '腘绳肌拉伸', muscles: [] })

    const context = await buildCoachContext(END)
    expect(context.windowStart).toBe('2026-10-09')
    expect(context.input.digest.period.days).toBe(COACH_WINDOW_DAYS)
    expect(context.input.digest.coverage.daysWithIntake).toBe(5)
    // 当天摄入 1800、目标 2100 → 还差 300；蛋白 80 / 140 → 还差 60
    expect(context.input.today.kcalSoFar).toBe(1800)
    expect(context.input.today.remainingKcal).toBe(300)
    expect(context.input.today.remainingProteinG).toBe(60)
    // 拉伸不算「今天练了」（与训练容量的口径一致）
    expect(context.input.today.trainedToday).toBe(false)
    expect(context.localHints.join()).toContain('蛋白质差 60 g')
    expect(context.fingerprint).toMatch(/^[0-9a-f]{8}$/)

    await addWorkout({ date: END, type: '力量', exercise: '杠铃划船', muscles: ['背'] })
    expect((await buildCoachContext(END)).input.today.trainedToday).toBe(true)
  })

  it('没有目标时不给「还差多少」：补 0 会被模型当成事实引用', async () => {
    await db.targets.clear()
    await seedDay(END, 74.4, 1800)
    const context = await buildCoachContext(END)
    expect(context.input.today.remainingKcal).toBeUndefined()
    expect(context.input.today.remainingProteinG).toBeUndefined()
  })

  it('FR-1602：关掉的恢复类字段连聚合都不参与，指纹也跟着变', async () => {
    await seedWeek()

    const on = await buildCoachContext(END)
    expect(on.input.digest.recovery.sleepDays).toBe(5)
    expect(on.input.digest.recovery.avgSleepHours).toBeDefined()

    const off = await buildCoachContext(END, {
      shareRecovery: { sleep: false, energy: true, soreness: true }
    })
    expect(off.input.digest.recovery.sleepDays).toBe(0)
    expect(off.input.digest.recovery.avgSleepHours).toBeUndefined()
    expect(JSON.stringify(off.input)).not.toContain('sleepHours')
    expect(off.fingerprint).not.toBe(on.fingerprint)
  })
})

describe('生成指导', () => {
  it('带上一份依据、模型与契约版本；请求体里没有原始记录', async () => {
    await seedWeek()
    const { fetchImpl, calls } = stubFetch([chatOk(coachJson())])
    const outcome = await generateAdvice({ date: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(true)
    const record = outcome.record
    expect(record?.date).toBe(END)
    expect(record?.model).toBe('test-model')
    expect(record?.taskVersion).toBe(1)
    expect(record?.content.advice[0].basis).toEqual(['intake.avgProteinG'])
    expect(record?.flaggedNumbers).toEqual([])

    const body = JSON.stringify(calls[0].body)
    expect(body).toContain('近 7 天')
    expect(body).toContain('remainingProteinG')
    expect(body).not.toContain('测试食材')
    expect(body).not.toContain('测试餐')

    expect((await listRecentAdvice()).length).toBe(1)
  })

  it('数据没变时同日不重复调用模型', async () => {
    await seedWeek()
    const { fetchImpl, calls } = stubFetch([chatOk(coachJson())])

    const first = await generateAdvice({ date: END }, { ...run, deps: { fetchImpl } })
    const second = await generateAdvice({ date: END }, { ...run, deps: { fetchImpl } })

    expect(first.cached).toBeFalsy()
    expect(second.cached).toBe(true)
    expect(second.record?.id).toBe(first.record?.id)
    expect(calls).toHaveLength(1)
  })

  it('手动刷新会再问一次，并覆盖当天那一条（不留过期版本）', async () => {
    await seedWeek()
    const { fetchImpl, calls } = stubFetch([chatOk(coachJson()), chatOk(coachJson({ headline: '换一版结论。' }))])

    const first = await generateAdvice({ date: END }, { ...run, deps: { fetchImpl } })
    const second = await generateAdvice({ date: END, force: true }, { ...run, deps: { fetchImpl } })

    expect(calls).toHaveLength(2)
    expect(second.record?.id).toBe(first.record?.id)
    expect(second.record?.content.headline).toBe('换一版结论。')
    expect(await listRecentAdvice()).toHaveLength(1)
  })

  it('没依据的建议不展示，条数与方法都留痕（NFR-13）', async () => {
    await seedWeek()
    const advice: CoachAdviceItem[] = [
      { kind: 'fact', text: '近 7 天平均蛋白偏低。', basis: ['intake.avgProteinG'] },
      { kind: 'inference', text: '你最近恢复不好。', basis: ['recovery.energyDays'] }
    ]
    const { fetchImpl } = stubFetch([chatOk(coachJson({ advice }))])
    const outcome = await generateAdvice({ date: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.record?.content.advice.map((item) => item.text)).toEqual(['近 7 天平均蛋白偏低。'])
    expect(outcome.record?.droppedAdvice).toBe(1)
    expect(outcome.notices.join()).toContain('找不到依据')
  })

  it('样本不足时标题带「样本不足」，调整目标类建议被去掉', async () => {
    await seedDay(END, 74.4, 1800)
    const advice: CoachAdviceItem[] = [
      { kind: 'inference', text: '热量目标可以下调一档。', basis: ['currentTargets.kcalTarget'] }
    ]
    const { fetchImpl } = stubFetch([chatOk(coachJson({ headline: '先把记录补齐。', advice }))])
    const outcome = await generateAdvice({ date: END }, { ...run, deps: { fetchImpl } })

    const record = outcome.record
    expect(record?.content.headline.startsWith('样本不足：')).toBe(true)
    expect(record?.content.advice).toEqual([])
    expect(record?.droppedAdvice).toBe(1)
    expect(record?.notices?.join()).toContain('样本不足')
  })

  it('模型失败不写任何指导，但本地缺口提示照常可用', async () => {
    await seedWeek()
    const { fetchImpl } = stubFetch([new Error('offline'), new Error('offline')])
    const outcome = await generateAdvice({ date: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.retriable).toBe(true)
    expect(outcome.record).toBeUndefined()
    expect(await listRecentAdvice()).toEqual([])

    const context = await buildCoachContext(END)
    expect(context.localHints.length).toBeGreaterThan(0)
  })
})

describe('采纳 / 不采纳（history.advice）', () => {
  it('表态写进 adviceLog，下一轮带上；同一天的表态不影响今天那一版的指纹', async () => {
    await seedWeek()
    const { fetchImpl } = stubFetch([chatOk(coachJson())])
    const first = await generateAdvice({ date: END }, { ...run, deps: { fetchImpl } })
    const record = first.record
    if (!record) throw new Error('没有生成指导')

    const marked = await markAdviceAdopted(record.id, 0, true)
    expect(marked?.content.advice[0].adopted).toBe(true)

    const next = await buildCoachContext('2026-10-16')
    expect(next.input.history.advice).toEqual([
      { date: END, text: record.content.advice[0].text, adopted: true }
    ])
    // 今天自己那条的表态不该让今天的指纹失效（否则点一下「采纳」就提示「数据有更新」）
    expect((await buildCoachContext(END)).fingerprint).toBe(record.fingerprint)
  })
})
