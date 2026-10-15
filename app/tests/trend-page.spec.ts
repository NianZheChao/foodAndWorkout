// @vitest-environment jsdom
/**
 * 趋势页（T1.6 / M6 FR-600）。
 *
 * 守住三件事：数值来自本地聚合（不是页面自己算的）、窗口切换写进 `?days=`、
 * 空区间显示「未记录」而不是一堆 0（FR-607）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import TrendPage from '@/pages/TrendPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { addDays, todayIso } from '@/app/date'
import { ensureDay, updateDay } from '@/data/repositories/days'
import { addIntake } from '@/data/repositories/intake'
import { putTargets } from '@/data/repositories/targets'

async function mountTrend(days: number | string = 7): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(`/trend?days=${days}`)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(TrendPage, { global: { plugins: [pinia, router] } })
  await vi.waitFor(() => {
    expect(wrapper.text()).toContain('区间与覆盖率')
  })
  return { wrapper, router }
}

/** 造 3 天数据：前天 86 kg、昨天 85.5 kg + 一餐、今天 85 kg。 */
async function seedDays(): Promise<void> {
  const today = todayIso()
  const yesterday = addDays(today, -1)
  const twoDaysAgo = addDays(today, -2)

  await ensureDay(twoDaysAgo)
  await updateDay(twoDaysAgo, { weightAmKg: 86 })
  await ensureDay(yesterday)
  await updateDay(yesterday, { weightAmKg: 85.5, weightPmKg: 86.2 })
  await ensureDay(today)
  await updateDay(today, { weightAmKg: 85 })
  await addIntake({
    date: yesterday,
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食材',
    foodSnapshot: {
      name: '测试食材',
      unit: '100g',
      kcal: 1500,
      proteinG: 120,
      fatG: 50,
      carbG: 150,
      fiberG: 20,
      sodiumMg: 1800
    },
    amount: { qty: 100, unit: '100g', grams: 100 },
    computed: { kcal: 1500, proteinG: 120, fatG: 50, carbG: 150, fiberG: 20, sodiumMg: 1800 }
  })
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  await putTargets({
    tdeeKcal: 2846,
    kcalTarget: 2420,
    proteinTargetG: 176,
    fatTargetG: 70,
    carbTargetG: 270,
    fiberTargetG: 30,
    sodiumMaxMg: 2300,
    weeklyTrainingDays: 3,
    weeklySetsPerMuscle: 10,
    targetWeightKg: 65,
    targetRateKgPerWeek: -0.39,
    reviewCadence: 'weekly'
  })
})

describe('趋势页', () => {
  it('把区间内的体重与摄入渲染出来，均线窗口与口径写在标题里', async () => {
    await seedDays()
    const { wrapper } = await mountTrend(7)
    const text = wrapper.text()

    expect(text).toContain('体重（晨重散点 + 7 日均线）')
    expect(text).toContain('86 → 85 kg')
    expect(text).toContain('-1 kg')
    expect(text).toContain('夜间净流失')
    expect(text).toContain('日均（1 天有记录）')
    expect(text).toContain('1500 kcal')
    expect(text).toContain('蛋白达标（≥ 目标 90%）')
    expect(text).toContain('0/1 天')
  })

  it('睡前重只出现在逐日表里，不进均线（FR-601）', async () => {
    await seedDays()
    const { wrapper } = await mountTrend(7)
    // 昨天睡前重 86.2 只出现在表格中；均线列里不出现该值
    expect(wrapper.text()).toContain('86.2')
    const headers = wrapper.findAll('thead th').map((th) => th.text())
    expect(headers).toContain('睡前')
    expect(headers).toContain('均线')
    expect(wrapper.text()).toContain('别当成「夜间代谢」')
  })

  it('覆盖率显示区间内有记录的天数（FR-608）', async () => {
    await seedDays()
    const { wrapper } = await mountTrend(7)
    expect(wrapper.text()).toContain('有饮食记录')
    expect(wrapper.text()).toContain('1 天（14%）')
    expect(wrapper.text()).toContain('有体重记录')
    expect(wrapper.text()).toContain('3 天（43%）')
    expect(wrapper.text()).toContain('区间内无训练记录。')
  })

  it('切换窗口会写进 URL，并把区间天数与覆盖率一起改掉', async () => {
    await seedDays()
    const { wrapper, router } = await mountTrend(7)
    const button = wrapper.findAll('button').find((item) => item.text() === '28 天')
    if (!button) throw new Error('找不到「28 天」按钮')
    await button.trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.query.days).toBe('28')
      expect(wrapper.text()).toContain('1 天（4%）')
    })
  })

  it('非法窗口值退回 7 天（FR-606）', async () => {
    await seedDays()
    const { wrapper } = await mountTrend('30')
    expect(wrapper.text()).toContain('共 7 天')
  })

  it('区间内没有记录时显示空状态，不把空值当 0（FR-607）', async () => {
    const { wrapper } = await mountTrend(7)
    expect(wrapper.text()).toContain('区间内没有任何记录')
    expect(wrapper.text()).toContain('不会被当成 0 拉低平均值')
  })

  it('没有目标值时提示去目标页做首次校准', async () => {
    await db.targets.clear()
    await seedDays()
    const { wrapper } = await mountTrend(7)
    expect(wrapper.text()).toContain('还没有目标值')
  })

  it('TDEE 样本不足时给出提示，而不是编一个数（DR-27）', async () => {
    await seedDays()
    const { wrapper } = await mountTrend(7)
    const text = wrapper.text()
    expect(text).toContain('实测 TDEE（反推）')
    expect(text).toContain('有效数据不足')
    expect(text).toContain('需要至少 7 天')
  })
})
