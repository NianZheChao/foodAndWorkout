// @vitest-environment jsdom
/**
 * 校准向导页（T3.5 / §6.7）。
 *
 * 守页面层的三件事：没配模型时**不装死**（本地数字 + 本地建议照常，按钮禁用并给出口）、
 * 通过门禁时能「采纳」写目标与校准记录、**被拦下时不提供采纳**（只说明原因）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import CalibrationPage from '@/pages/CalibrationPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { addDays, todayIso } from '@/app/date'
import { addIntake } from '@/data/repositories/intake'
import { updateDay } from '@/data/repositories/days'
import { getTargets, listCalibrations, putTargets } from '@/data/repositories/targets'
import { saveModelConfig } from '@/data/repositories/modelConfig'
import { chatOk, stubFetch } from './helpers/llm'

const TODAY = todayIso()

function reviewJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    recommended: true,
    deltaKcal: -100,
    direction: '下调',
    confidence: 'medium',
    rationale: '近 4 周体重缓慢下降，建议下调 100 kcal。',
    watchItems: ['盯住体重均线'],
    ...patch
  })
}

async function mountPage(): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/calibration')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(CalibrationPage, { global: { plugins: [pinia, router] } })
  await vi.waitFor(() => {
    expect(wrapper.find('[data-ready="true"]').exists()).toBe(true)
  })
  return { wrapper, router }
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label))
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

function hasButton(wrapper: VueWrapper, label: string): boolean {
  return wrapper.findAll('button').some((item) => item.text().includes(label))
}

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

/** 16 天记录：覆盖率过半、TDEE 样本 16 天，门禁不会误触。 */
async function seedWeeks(): Promise<void> {
  for (let index = 0; index < 16; index += 1) {
    await seedDay(addDays(TODAY, index - 15), 76 - index * 0.1, 1800)
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

describe('校准向导页', () => {
  it('没配模型时不装死：本地数字与本地建议照常，生成按钮禁用并给出口', async () => {
    await seedWeeks()
    const { wrapper } = await mountPage()

    expect(wrapper.text()).toContain('本地数字')
    expect(wrapper.text()).toContain('实测 TDEE')
    expect(wrapper.text()).toContain('本地建议')
    expect(wrapper.text()).toContain('还没配模型')
    expect(button(wrapper, '生成校准建议').element.hasAttribute('disabled')).toBe(true)
    expect(hasButton(wrapper, '去模型设置')).toBe(true)
  })

  it('通过门禁后能采纳：写入目标 + 留一行校准记录，然后回目标页', async () => {
    await seedWeeks()
    await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'stub' })
    vi.stubGlobal(
      'fetch',
      stubFetch([
        chatOk(reviewJson({ rationale: '近 4 周体重缓慢下降，建议下调 100 kcal（照这样 6 周能到 68 kg）。' }))
      ]).fetchImpl
    )

    const { wrapper, router } = await mountPage()
    await button(wrapper, '生成校准建议').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('下调')
      expect(wrapper.text()).toContain('接下来盯这几项')
      // 68 不在白名单里 → 被守卫标出来
      expect(wrapper.text()).toContain('找不到出处')
    })
    expect(hasButton(wrapper, '采纳')).toBe(true)

    await button(wrapper, '采纳').trigger('click')
    await vi.waitFor(async () => {
      expect((await getTargets())?.kcalTarget).toBe(2000)
      expect(await listCalibrations()).toHaveLength(1)
      expect(router.currentRoute.value.path).toBe('/targets')
    })
  })

  it('样本不足被门禁拦下：显示原因，**不提供采纳**', async () => {
    await seedDay(TODAY, 75, 1800)
    await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'stub' })
    vi.stubGlobal('fetch', stubFetch([chatOk(reviewJson())]).fetchImpl)

    const { wrapper } = await mountPage()
    expect(wrapper.text()).toContain('样本不足')

    await button(wrapper, '生成校准建议').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('拦下')
      expect(wrapper.text()).toContain('不提供「采纳」')
    })
    expect(hasButton(wrapper, '采纳')).toBe(false)
    expect(await listCalibrations()).toEqual([])
  })
})
