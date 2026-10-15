// @vitest-environment jsdom
/**
 * 目标页（M9 / FR-900）：
 * - 首次估算必须本地算（BMR × 活动系数 → 阶段调整），不调用模型
 * - 任何改动都要留一行校准记录（FR-903）
 * - 单次 ±150 kcal 以上、距上次校准不足 2 周都要先提示再落库（FR-904 / FR-905）
 * - BMI ≥ 28 时给蛋白口径提示（FR-906）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import TargetsPage from '@/pages/TargetsPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { saveProfile } from '@/data/repositories/profile'
import { getTargets, listCalibrations } from '@/data/repositories/targets'
import type { ProfileRecord } from '@/domain/types'

const PROFILE: ProfileRecord = {
  id: 'current',
  sex: 'male',
  age: 30,
  heightCm: 175,
  weightKg: 75,
  goal: '减脂',
  trainingLevel: '新手',
  injuries: '无',
  allergies: '无',
  dietType: '无特殊',
  dailyCookMinutes: 30,
  seasonings: {},
  equipment: ['哑铃'],
  conventions: [],
  mutedFields: [],
  updatedAt: Date.now()
}

async function mountPage(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/targets')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(TargetsPage, { global: { plugins: [pinia, router] } })
  await vi.waitFor(() => {
    // 页面里有「读库 → 再读库」的链式 await，等它把 loaded 置位再断言
    expect(wrapper.find('[data-ready="true"]').exists()).toBe(true)
  })
  return wrapper
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text() === label)
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

/** 按 van-field 的 label 取输入框；标签重复时取第一个。 */
function inputFor(wrapper: VueWrapper, label: string) {
  const field = wrapper
    .findAll('.van-field')
    .find((item) => item.find('.van-field__label').exists() && item.find('.van-field__label').text() === label)
  if (!field) throw new Error(`找不到字段「${label}」`)
  const input = field.find('input')
  if (!input.exists()) throw new Error(`字段「${label}」没有输入框`)
  return input
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('目标页：首次估算（FR-902）', () => {
  it('没有档案时先引导去填档案', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('先填档案')
    expect(wrapper.text()).toContain('BMR')
    expect(await getTargets()).toBeUndefined()
  })

  it('有档案时本地算出 BMR / TDEE / 热量目标，并预填进表单', async () => {
    await saveProfile(PROFILE)
    const wrapper = await mountPage()
    const text = wrapper.text()
    // Mifflin-St Jeor：10×75 + 6.25×175 − 5×30 + 5 = 1698.75
    expect(text).toContain('1698.8')
    // 新手 → 每周 3 练 → 活动系数 1.55 → TDEE 2633.1
    expect(text).toContain('2633.1')
    expect(text).toContain('减脂 -15%')
    expect((inputFor(wrapper, '热量目标').element as HTMLInputElement).value).toBe('2240')
  })

  it('写入目标时同时留下第一行校准记录（FR-903）', async () => {
    await saveProfile(PROFILE)
    const wrapper = await mountPage()
    await button(wrapper, '写入目标并留痕').trigger('click')

    await vi.waitFor(async () => {
      const targets = await getTargets()
      expect(targets?.kcalTarget).toBe(2240)
      expect(targets?.proteinTargetG).toBe(150)
      // 校准留痕是写入目标的第二步，等到它落库再断言
      expect(await listCalibrations()).toHaveLength(1)
    })

    const records = await listCalibrations()
    expect(records[0].basis).toContain('首次目标估算')
    expect(records[0].measuredTdee).toBe(2633)
    expect(wrapper.text()).toContain('校准记录')
  })
})

describe('目标页：调整门禁（FR-904 / FR-905）', () => {
  async function withTargets(): Promise<VueWrapper> {
    await saveProfile(PROFILE)
    const wrapper = await mountPage()
    await button(wrapper, '写入目标并留痕').trigger('click')
    await vi.waitFor(async () => {
      expect(await getTargets()).toBeDefined()
    })
    // 库里有值不等于界面已经切到「调整目标」视图，等按钮真的出现
    await vi.waitFor(() => {
      expect(wrapper.findAll('button').some((item) => item.text() === '保存调整')).toBe(true)
    })
    return wrapper
  }

  it('改动超过 ±150 kcal 时先让用户确认，确认后按改动值留痕', async () => {
    const wrapper = await withTargets()
    await inputFor(wrapper, '热量目标').setValue('1900')
    await button(wrapper, '保存调整').trigger('click')

    expect(wrapper.text()).toContain('确认这次调整')
    expect(wrapper.text()).toContain('超过 ±150 kcal 的上限')
    expect((await getTargets())?.kcalTarget).toBe(2240)

    await button(wrapper, '确认并写入校准记录').trigger('click')
    await vi.waitFor(async () => {
      expect((await getTargets())?.kcalTarget).toBe(1900)
    })
    const records = await listCalibrations()
    // 首次估算一行 + 本次校准一行
    expect(records).toHaveLength(2)
    expect(records[0].kcalBefore).toBe(2240)
    expect(records[0].kcalAfter).toBe(1900)
  })

  it('距上次校准不足 2 周会提示样本可能不足（FR-905）', async () => {
    const wrapper = await withTargets()
    await inputFor(wrapper, '热量目标').setValue('2170')
    await button(wrapper, '保存调整').trigger('click')
    expect(wrapper.text()).toContain('样本可能不足')
  })

  it('取消时不写库', async () => {
    const wrapper = await withTargets()
    await inputFor(wrapper, '热量目标').setValue('1900')
    await button(wrapper, '保存调整').trigger('click')
    await button(wrapper, '取消').trigger('click')

    expect(wrapper.text()).not.toContain('确认这次调整')
    expect((await getTargets())?.kcalTarget).toBe(2240)
    expect(await listCalibrations()).toHaveLength(1)
  })

  it('只改非热量字段也要留痕（FR-903）', async () => {
    const wrapper = await withTargets()
    await inputFor(wrapper, '蛋白(g)').setValue('180')
    await button(wrapper, '保存调整').trigger('click')
    await button(wrapper, '确认并写入校准记录').trigger('click')
    await vi.waitFor(async () => {
      expect((await getTargets())?.proteinTargetG).toBe(180)
    })
    const records = await listCalibrations()
    expect(records).toHaveLength(2)
    // 最新的一行在前
    expect(records[0].kcalBefore).toBe(records[0].kcalAfter)
    expect(records[0].basis).toContain('蛋白目标')
  })
})

describe('目标页：高体脂蛋白口径（FR-906）', () => {
  it('BMI ≥ 28 时提示改用目标体重或当前体重 × 1.6，并可一键重算', async () => {
    // 95 kg / 1.75 m → BMI 31.0，专门造一个高 BMI 的合成档案
    await saveProfile({ ...PROFILE, weightKg: 95 })
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('BMI 31')
    expect(wrapper.text()).toContain('当前体重 × 1.6')

    await button(wrapper, '按当前体重 × 1.6 重算蛋白').trigger('click')
    await vi.waitFor(() => {
      expect((inputFor(wrapper, '蛋白(g)').element as HTMLInputElement).value).toBe('152')
    })
  })
})
