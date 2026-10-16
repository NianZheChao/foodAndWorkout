// @vitest-environment jsdom
/**
 * 「我的」域根页（2026-10-16 新开）。
 *
 * 它是重构的产物：档案 / 目标 / 本机数据 / 关于这些「关于我这个人」的页面从「今日页 → 更多」
 * 与设置页里收拢到这一支，于是设置只管「应用怎么跑」。
 *
 * 守三件事：数字与状态都来自仓储（页面不做计算）、没档案时给得出去路、
 * 同级页面（这里以「关于与免责声明」为例）在导航条里常驻可达（FR-1608）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import MePage from '@/pages/MePage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { fmtNumber } from '@/domain/format'
import { initializeApp } from '@/app/bootstrap'
import { countFoods } from '@/data/repositories/foods'
import { FOOD_SEED_VERSION, foodSeed } from '@/data/seed'
import { saveProfile } from '@/data/repositories/profile'
import { putTargets } from '@/data/repositories/targets'
import type { ProfileRecord } from '@/domain/types'

const PROFILE: ProfileRecord = {
  id: 'current',
  sex: 'male',
  age: 30,
  heightCm: 175,
  weightKg: 75,
  goal: '减脂',
  trainingLevel: '新手',
  conventions: [],
  updatedAt: Date.now()
}

const TARGETS = {
  tdeeKcal: 2400,
  kcalTarget: 1900,
  proteinTargetG: 140,
  fatTargetG: 60,
  carbTargetG: 180,
  fiberTargetG: 30,
  sodiumMaxMg: 2300,
  weeklyTrainingDays: 4,
  weeklySetsPerMuscle: 10,
  targetWeightKg: 70,
  targetRateKgPerWeek: 0.5,
  reviewCadence: 'weekly' as const
}

async function mountMe(): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/me')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(MePage, { global: { plugins: [pinia, router] } })
  await vi.waitFor(() => {
    expect(wrapper.find('section').attributes('data-ready')).toBe('true')
  })
  return { wrapper, router }
}

function chip(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('.domain-nav .nav-chip').find((item) => item.text() === label)
  if (!found) throw new Error(`导航条里没有「${label}」`)
  return found
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('我的页（域根）', () => {
  it('种子食物库与 schema 版本摆在「本机数据」里（搬自今日页，数字来自仓储）', async () => {
    const report = await initializeApp()
    expect(report.firstRun).toBe(true)

    const { wrapper } = await mountMe()
    const text = wrapper.text()
    expect(text).toContain(String(foodSeed.length))
    expect(text).toContain(String(await countFoods()))
    expect(text).toContain(FOOD_SEED_VERSION)
    expect(text).toContain(`v${db.verno}`)
  })

  it('没有档案时给出去路，不摆一排空值', async () => {
    const { wrapper, router } = await mountMe()
    expect(wrapper.text()).toContain('还没有档案')

    const entry = wrapper.findAll('button').find((item) => item.text() === '去填档案')
    if (!entry) throw new Error('找不到「去填档案」')
    await entry.trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/profile')
    })
  })

  it('有档案与目标时，把基础项与当前目标值列出来（没有目标就给校准入口）', async () => {
    await saveProfile(PROFILE)
    const { wrapper } = await mountMe()
    expect(wrapper.text()).toContain('还没有目标值')
    expect(wrapper.text()).toContain('30 岁')
    expect(wrapper.text()).toContain('175 cm')

    await putTargets(TARGETS)
    const { wrapper: withTargets } = await mountMe()
    const text = withTargets.text()
    expect(text).not.toContain('还没有目标值')
    expect(text).toContain(`${fmtNumber(TARGETS.kcalTarget)} kcal`)
    expect(text).toContain(`${fmtNumber(TARGETS.proteinTargetG)} g`)
    expect(text).toContain(`${fmtNumber(TARGETS.targetWeightKg)} kg`)
    expect(text).toContain('还没有校准过')
  })

  it('导航条里常驻档案 / 数据 / 关于：点「关于与免责声明」能进 /about（FR-1608）', async () => {
    const { wrapper, router } = await mountMe()
    expect(wrapper.findAll('.domain-nav .nav-chip').map((item) => item.text())).toEqual([
      '我的',
      '档案',
      '数据',
      '关于与免责声明'
    ])
    expect(chip(wrapper, '我的').classes()).toContain('nav-chip--on')

    await chip(wrapper, '关于与免责声明').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/about')
    })
  })
})