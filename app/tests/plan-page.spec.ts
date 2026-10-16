// @vitest-environment jsdom
/**
 * 推荐清单页（T3.8 / §6.5 / §6.6）。
 *
 * 守页面层的三件事：开关关着时**两个生成按钮都是禁用的**（FR-1003，并把原因与去处写清楚）、
 * 已生成的清单显示的是**本地复算后的数值**（克数、合计、缺口对比）、
 * 「将要发送的内容」看得见（用户知道要发什么）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import PlanPage from '@/pages/PlanPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { seedFoods } from '@/data/repositories/foods'
import { foodSeed, FOOD_SEED_VERSION } from '@/data/seed'
import { putPlan } from '@/data/repositories/plans'
import { saveProfile } from '@/data/repositories/profile'
import { saveSettings } from '@/data/repositories/settings'
import { putTargets } from '@/data/repositories/targets'
import { addIntake } from '@/data/repositories/intake'
import { todayIso } from '@/app/date'
import type { MealPlanRecord, ProfileRecord, TrainingPlanRecord } from '@/domain/types'

const TODAY = todayIso()

async function mountPlan(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/plan')
  await router.isReady()
  return mount(PlanPage, { global: { plugins: [createPinia(), router] } })
}

/** 页面要读库（缺口 / 食物库 / 已生成记录），用 waitFor 等它把 loaded 置上。 */
async function settle(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(wrapper.find('section').attributes('data-ready')).toBe('true'))
  await flushPromises()
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label))
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

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
    equipment: ['哑铃'],
    mealMinutes: 30,
    updatedAt: 1,
    ...patch
  }
}

const trainingRecord: TrainingPlanRecord = {
  id: 'planT_1',
  kind: 'training',
  date: TODAY,
  fingerprint: 'deadbeef',
  model: 'test-model',
  taskVersion: 1,
  notices: ['剔除了 1 个用不到器材的动作：杠铃硬拉（档案里的可用器材没有「杠铃」）'],
  content: {
    focus: '今天先补腿',
    estimatedMinutes: 20,
    exercises: [
      {
        name: '哑铃深蹲',
        muscles: ['腿'],
        sets: 4,
        reps: 10,
        weightKg: 22.5,
        rpe: 7,
        equipment: ['哑铃'],
        progression: '比上次 +2.5kg',
        reason: '腿部只练了 2 组',
        weightNote: '比上次（2026-10-14 · 2x10x20）重了 13%，超过 +10%，涨之前先确认'
      }
    ],
    notes: ['组间休息 90 秒']
  },
  createdAt: 1,
  updatedAt: 1
}

const mealRecord: MealPlanRecord = {
  id: 'planM_1',
  kind: 'meal',
  date: TODAY,
  fingerprint: 'cafebabe',
  model: 'test-model',
  taskVersion: 1,
  content: {
    title: '鸡胸西兰花',
    items: [
      { food: '鸡胸肉', grams: 200, dish: '香煎', foodId: '鸡胸肉(生 去皮)', facts: { kcal: 266, proteinG: 38.8, fatG: 10, carbG: 5, fiberG: 0, sodiumMg: 69.6 } },
      { food: '本地没有的菜', grams: 100 }
    ],
    seasonings: [
      { food: '橄榄油', grams: 8, seasoning: true, foodId: '橄榄油', facts: { kcal: 71.9, proteinG: 0, fatG: 8, carbG: 0, fiberG: 0, sodiumMg: 0 } }
    ],
    totals: { kcal: 337.9, proteinG: 38.8, fatG: 18, carbG: 5, fiberG: 0, sodiumMg: 69.6 },
    missing: ['本地没有的菜'],
    totalsPreview: { kcal: 500, proteinG: 40, fatG: 10, carbG: 5 },
    shoppingList: [{ item: '鸡胸肉', amount: '500g', substitute: '鸡腿肉去皮' }]
  },
  notices: ['本地食物库里没有「本地没有的菜」，这几行没有算进合计 —— 先去「食物库」把它的数值补上（FR-806）'],
  createdAt: 1,
  updatedAt: 1
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
  await addIntake({
    date: TODAY,
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
})

describe('推荐清单页', () => {
  it('开关关着时不给生成按钮，并指出开关与档案两个去处', async () => {
    await saveProfile(profile({ allergies: [] }))
    const wrapper = await mountPlan()
    await settle(wrapper)

    expect(wrapper.text()).toContain('推荐现在是关着的')
    expect(wrapper.text()).toContain('设置 → 生成式推荐')
    expect(wrapper.text()).toContain('过敏')
    // 按钮留着（用户看得见这条路），但都是禁用的：整条链路不可用
    expect(button(wrapper, '生成今天的训练').classes()).toContain('van-button--disabled')
    expect(button(wrapper, '生成今天还能吃什么').classes()).toContain('van-button--disabled')
    expect(wrapper.text()).toContain('去设置打开开关')
    expect(wrapper.text()).toContain('去档案补约束')
  })

  it('开关开着但约束没齐时，明细里说清缺哪几项', async () => {
    await saveProfile(profile({ equipment: [] }))
    await saveSettings({ recommendEnabled: true })
    const wrapper = await mountPlan()
    await settle(wrapper)

    expect(wrapper.text()).toContain('可用器材')
    expect(wrapper.text()).toContain('去档案补约束')
  })

  it('已生成的训练计划显示动作与本地提示；模型写在时长由本地按组数算', async () => {
    await saveProfile(profile())
    await saveSettings({ recommendEnabled: true })
    await putPlan(trainingRecord)
    const wrapper = await mountPlan()
    await settle(wrapper)

    expect(wrapper.text()).toContain('今天先补腿')
    expect(wrapper.text()).toContain('哑铃深蹲')
    expect(wrapper.text()).toContain('20 分钟')
    expect(wrapper.text()).toContain('超过 +10%')
    expect(wrapper.text()).toContain('剔除了 1 个用不到器材的动作')
    // 数据变了才提示「可以刷新」；这条记录的指纹与现在的输入不一致，所以会出现
    expect(wrapper.text()).toContain('今天的数据已经变了')
  })

  it('已生成的食谱显示本地复算的合计、缺口对比与采购清单', async () => {
    await saveProfile(profile())
    await saveSettings({ recommendEnabled: true })
    await putPlan(mealRecord)
    const wrapper = await mountPlan()
    await settle(wrapper)

    expect(wrapper.text()).toContain('鸡胸西兰花')
    expect(wrapper.text()).toContain('香煎')
    expect(wrapper.text()).toContain('本地库里没有')
    expect(wrapper.text()).toContain('与今天的缺口对比')
    // 2100 - 700 = 1400 还差；这一顿 337.9
    expect(wrapper.text()).toContain('337.9')
    expect(wrapper.text()).toContain('1400')
    expect(wrapper.text()).toContain('不买也行：鸡腿肉去皮')
  })

  it('将要发送的内容可以展开，且里面没有原始记录', async () => {
    await saveProfile(profile())
    await saveSettings({ recommendEnabled: true })
    const wrapper = await mountPlan()
    await settle(wrapper)

    expect(wrapper.find('.payload').exists()).toBe(false)
    await button(wrapper, '展开').trigger('click')
    await flushPromises()
    const payload = wrapper.find('.payload')
    expect(payload.exists()).toBe(true)
    expect(payload.text()).toContain('needsRecovery')
    expect(payload.text()).not.toContain('测试餐')
  })

  it('页面常驻返回按钮与开关说明', async () => {
    await saveProfile(profile())
    await saveSettings({ recommendEnabled: true })
    const wrapper = await mountPlan()
    await settle(wrapper)
    expect(wrapper.find('.back-btn').exists()).toBe(true)
    expect(wrapper.text()).toContain('FR-803')
  })
})