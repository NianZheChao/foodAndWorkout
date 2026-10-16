// @vitest-environment node
/**
 * 推荐的用例层（T3.8 / §6.5 / §6.6）。
 *
 * 守六条：门禁真的拦（开关关 / 约束没齐时一次模型都不调用）、输入里只有本地摘要、
 * 本地复核在写库之前生效（器材不满足的动作不会留在记录里）、食谱按食物库重算、
 * 输入没变不重复花钱、模型失败不落库。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildPlanContext,
  gateMessage,
  generateMealPlan,
  generateTrainingPlan,
  loadPlanRecords
} from '@/application/plan'
import { db } from '@/data/db'
import { addIntake } from '@/data/repositories/intake'
import { seedFoods } from '@/data/repositories/foods'
import { foodSeed, FOOD_SEED_VERSION } from '@/data/seed'
import { saveProfile } from '@/data/repositories/profile'
import { saveSettings } from '@/data/repositories/settings'
import { putTargets } from '@/data/repositories/targets'
import { addWorkout } from '@/data/repositories/workout'
import { chatOk, fakeResponse, stubFetch } from './helpers/llm'
import type { ModelConfigRecord, ProfileRecord } from '@/domain/types'

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

function profile(patch: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: 'current',
    sex: 'male',
    age: 30,
    heightCm: 175,
    weightKg: 74,
    goal: '减脂',
    trainingLevel: '中级',
    conventions: [],
    avoidFoods: ['内脏'],
    allergies: ['无'],
    equipment: ['哑铃', '自重'],
    mealMinutes: 30,
    updatedAt: 1,
    ...patch
  }
}

function trainingJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    focus: '今天先补腿',
    estimatedMinutes: 40,
    exercises: [
      {
        name: '哑铃深蹲',
        muscles: ['腿'],
        sets: 4,
        reps: 10,
        weightKg: 20,
        rpe: 7,
        equipment: ['哑铃'],
        progression: '比上次 +2.5kg',
        reason: '腿部只练了 3 组'
      },
      {
        name: '杠铃硬拉',
        muscles: ['背'],
        sets: 3,
        reps: 8,
        weightKg: 60,
        equipment: ['杠铃'],
        reason: '背部欠账'
      }
    ],
    notes: ['组间休息 90 秒'],
    ...patch
  })
}

function mealJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: '鸡胸西兰花',
    items: [
      { food: '鸡胸肉(生 去皮)', grams: 200, dish: '香煎' },
      { food: '本地没有的菜', grams: 100 }
    ],
    seasonings: [{ food: '橄榄油', grams: 8 }],
    totalsPreview: { kcal: 500, proteinG: 40, fatG: 10, carbG: 5 },
    shoppingList: [{ item: '鸡胸肉', amount: '500g', substitute: '鸡腿肉去皮' }],
    ...patch
  })
}

async function seedToday(): Promise<void> {
  await addIntake({
    date: END,
    meal: '午餐',
    dish: '测试餐',
    foodId: '鸡胸肉(生 去皮)',
    foodSnapshot: {
      name: '鸡胸肉(生 去皮)',
      unit: '100g',
      kcal: 700,
      proteinG: 60,
      fatG: 20,
      carbG: 60,
      fiberG: 5,
      sodiumMg: 1200
    },
    amount: { qty: 100, unit: 'g', grams: 100 },
    computed: { kcal: 700, proteinG: 60, fatG: 20, carbG: 60, fiberG: 5, sodiumMg: 1200 }
  })
  await addWorkout({
    date: '2026-10-14',
    type: '力量',
    exercise: '哑铃深蹲',
    muscles: ['腿'],
    sets: [
      { reps: 10, weightKg: 20, bodyweight: false },
      { reps: 10, weightKg: 20, bodyweight: false }
    ],
    volumeRaw: '2x10x20'
  })
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
  await seedFoods(foodSeed, FOOD_SEED_VERSION)
  await saveProfile(profile())
  await saveSettings({ recommendEnabled: true })
  await seedToday()
})

describe('门禁（FR-1003）', () => {
  it('开关关着就整条链路不可用，一次模型都不调用', async () => {
    await saveSettings({ recommendEnabled: false })
    const { fetchImpl, calls } = stubFetch([chatOk(trainingJson())])
    const outcome = await generateTrainingPlan({ date: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(false)
    expect(outcome.blocked).toContain('设置')
    expect(calls).toHaveLength(0)
    expect(await loadPlanRecords(END)).toEqual({ training: undefined, meal: undefined })
  })

  it('四项约束没齐也拦下，并说清缺哪几项', async () => {
    await saveProfile(profile({ allergies: ['  '], equipment: [] }))
    const context = await buildPlanContext(END)
    expect(context.gate.missing).toEqual(['过敏', '可用器材'])
    expect(gateMessage(context.gate)).toContain('过敏 / 可用器材')

    const { fetchImpl, calls } = stubFetch([chatOk(mealJson())])
    const outcome = await generateMealPlan({ date: END }, { ...run, deps: { fetchImpl } })
    expect(outcome.ok).toBe(false)
    expect(outcome.blocked).toContain('FR-1003')
    expect(calls).toHaveLength(0)
  })
})

describe('组装输入（FR-805）', () => {
  it('只有缺口、肌群账、上次写法与约束，没有原始记录', async () => {
    const context = await buildPlanContext(END)
    const text = JSON.stringify(context.training)
    expect(text).not.toContain('测试餐')
    expect(text).toContain('哑铃深蹲')
    // 今天的缺口：2100 - 700 = 1400；蛋白 140 - 60 = 80
    expect(context.training.today.remainingKcal).toBe(1400)
    expect(context.training.today.remainingProteinG).toBe(80)
    expect(context.training.today.trainedToday).toBe(false)
    expect(context.training.muscles[0]).toEqual({ muscle: '腿', sets: 2, hoursSinceLast: 24 })
    // 24 小时 < 48，进「还没恢复」名单（FR-801 的恢复优先）
    expect(context.training.needsRecovery).toEqual(['腿'])
    expect(context.training.constraints.join()).toContain('忌口：内脏')
    // 常用食材名只给名称，不给数值
    expect(context.meal.commonFoods).toEqual(['鸡胸肉(生 去皮)'])
    expect(JSON.stringify(context.meal)).not.toContain('proteinG":6')
    expect(context.fingerprints.training).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('生成训练计划', () => {
  it('本地剔掉用不到器材的动作，落库的是复核之后的结果', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk(trainingJson())])
    const outcome = await generateTrainingPlan({ date: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(true)
    const record = outcome.record
    expect(record?.kind).toBe('training')
    expect(record?.content.exercises.map((item) => item.name)).toEqual(['哑铃深蹲'])
    expect(record?.notices?.[0]).toContain('杠铃')
    // 杠铃硬拉被剔掉后只剩 4 组：4 × 3 分钟 + 8 分钟热身 = 20，不是模型写的 40
    expect(record?.content.estimatedMinutes).toBe(20)
    expect(record?.model).toBe('test-model')

    // 请求体里带着器材约束与恢复名单
    const body = JSON.stringify(calls[0].body)
    expect(body).toContain('可用器材')
    expect(body).toContain('needsRecovery')
  })

  it('输入没变就复用当天那一条，不重复花钱；force 才再调一次', async () => {
    const first = stubFetch([chatOk(trainingJson())])
    const initial = await generateTrainingPlan({ date: END }, { ...run, deps: { fetchImpl: first.fetchImpl } })
    expect(first.calls).toHaveLength(1)

    const second = stubFetch([chatOk(trainingJson({ focus: '改过的重点' }))])
    const cached = await generateTrainingPlan({ date: END }, { ...run, deps: { fetchImpl: second.fetchImpl } })
    expect(second.calls).toHaveLength(0)
    expect(cached.cached).toBe(true)
    expect(cached.record?.id).toBe(initial.record?.id)

    const forced = await generateTrainingPlan({ date: END, force: true }, { ...run, deps: { fetchImpl: second.fetchImpl } })
    expect(second.calls).toHaveLength(1)
    expect(forced.record?.content.focus).toBe('改过的重点')
    // 同一天同一类只留一条：覆盖而不是新增
    expect(await db.plans.count()).toBe(1)
  })

  it('模型失败不写任何记录', async () => {
    const { fetchImpl } = stubFetch([fakeResponse('boom', 500)])
    const outcome = await generateTrainingPlan({ date: END }, { ...run, deps: { fetchImpl } })
    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.kind).toBeTruthy()
    expect(await db.plans.count()).toBe(0)
  })
})

describe('生成食谱', () => {
  it('按食物库重算克数与营养；没有的设备行不进合计', async () => {
    const { fetchImpl } = stubFetch([chatOk(mealJson())])
    const outcome = await generateMealPlan({ date: END }, { ...run, deps: { fetchImpl } })

    expect(outcome.ok).toBe(true)
    const content = outcome.record?.content
    // 鸡胸肉 200g：133 × 2 = 266 kcal；橄榄油 8g：899 × 0.08 = 71.92
    expect(content?.totals.kcal).toBeCloseTo(337.92, 5)
    expect(content?.missing).toEqual(['本地没有的菜'])
    expect(content?.items[1].facts).toBeUndefined()
    // 模型自报 500 与本地 337.92 差得远，提示里要说明「已按本地库显示」
    expect(outcome.notices.some((note) => note.includes('已按本地库显示'))).toBe(true)
    // 采购清单照原样留着（FR-804）
    expect(content?.shoppingList?.[0].substitute).toBe('鸡腿肉去皮')
    expect(outcome.record?.kind).toBe('meal')
  })
})