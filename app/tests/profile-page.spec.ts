// @vitest-environment jsdom
/**
 * 档案页（M10 / FR-1000）：
 * - 字段与 `profile.md` 一一对应，长期事实（FR-1001 / FR-1002）
 * - 忌口 / 过敏 / 器材要能存下来给推荐模块读（FR-1003）
 * - 记录口径约定可见可改（FR-1004）；界面上没有库存入口（FR-1005）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ProfilePage from '@/pages/ProfilePage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { getProfile, saveProfile } from '@/data/repositories/profile'
import { getSettings } from '@/data/repositories/settings'
import type { ProfileRecord } from '@/domain/types'

async function mountPage(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/profile')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(ProfilePage, { global: { plugins: [pinia, router] } })
  await vi.waitFor(() => {
    expect(wrapper.find('[data-ready="true"]').exists()).toBe(true)
  })
  return wrapper
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text() === label)
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

function inputFor(wrapper: VueWrapper, label: string) {
  const field = wrapper
    .findAll('.van-field')
    .find((item) => item.find('.van-field__label').exists() && item.find('.van-field__label').text() === label)
  if (!field) throw new Error(`找不到字段「${label}」`)
  const input = field.find('input')
  if (!input.exists()) throw new Error(`字段「${label}」没有输入框`)
  return input
}

function textarea(wrapper: VueWrapper): HTMLTextAreaElement {
  const found = wrapper.find('textarea')
  if (!found.exists()) throw new Error('找不到多行输入框')
  return found.element as HTMLTextAreaElement
}

const EXISTING: ProfileRecord = {
  id: 'current',
  sex: 'male',
  age: 30,
  heightCm: 175,
  weightKg: 75,
  goal: '减脂',
  trainingLevel: '新手',
  wakeTime: '09:00',
  sleepTime: '01:00',
  conventions: ['不记录饮水'],
  updatedAt: Date.now()
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('档案页', () => {
  it('第一次进入时把长期约定预填好，并且界面上没有库存入口（FR-1004 / FR-1005）', async () => {
    const wrapper = await mountPage()
    const text = textarea(wrapper)
    expect(text.value).toContain('不记录饮水')
    expect(text.value).toContain('不记录食材库存')
    expect(text.value).toContain('晨起排尿后、空腹')
    expect(wrapper.text()).not.toContain('库存表')
    expect(await getProfile()).toBeUndefined()
  })

  it('保存时把性别 / 年龄 / 身高 / 体重 / 约定一起写进本机（FR-1001 / FR-1004）', async () => {
    const wrapper = await mountPage()
    await inputFor(wrapper, '年龄').setValue('30')
    await inputFor(wrapper, '身高(cm)').setValue('175')
    await inputFor(wrapper, '体重(kg)').setValue('75')

    await button(wrapper, '保存档案').trigger('click')

    await vi.waitFor(async () => {
      expect(await getProfile()).toBeDefined()
    })
    const saved = (await getProfile()) as ProfileRecord
    expect(saved.age).toBe(30)
    expect(saved.heightCm).toBe(175)
    expect(saved.weightKg).toBe(75)
    expect(saved.conventions.some((line) => line.includes('不记录饮水'))).toBe(true)
    // 四项安全边界按 FR-1003 恢复到模型里（T3.8），没填就是空数组而不是 undefined
    expect(saved.avoidFoods).toEqual([])
    expect(saved.allergies).toEqual([])
    expect(saved.equipment).toEqual([])
    expect(saved.mealMinutes).toBeUndefined()
    // 仍然不恢复的是这几个：推荐输入里用不到
    expect('seasonings' in saved).toBe(false)
    expect('budgetPerDayCny' in saved).toBe(false)
  })

  it('已有档案时回填原值，改完再存不会丢字段', async () => {
    await saveProfile(EXISTING)
    const wrapper = await mountPage()
    expect((inputFor(wrapper, '身高(cm)').element as HTMLInputElement).value).toBe('175')
    expect((inputFor(wrapper, '起床时间').element as HTMLInputElement).value).toBe('09:00')

    await inputFor(wrapper, '体重(kg)').setValue('74')
    await button(wrapper, '保存档案').trigger('click')
    await vi.waitFor(async () => {
      expect((await getProfile())?.weightKg).toBe(74)
    })
    const saved = (await getProfile()) as ProfileRecord
    expect(saved.wakeTime).toBe('09:00')
    expect(saved.conventions).toContain('不记录饮水')
  })

  it('年龄 / 身高 / 体重的离谱输入被拦下，不写库（BR-16）', async () => {
    const wrapper = await mountPage()
    await inputFor(wrapper, '年龄').setValue('30')
    await inputFor(wrapper, '身高(cm)').setValue('175')
    await inputFor(wrapper, '体重(kg)').setValue('500')
    await button(wrapper, '保存档案').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('体重要填 25-300 kg')
    })
    expect(await getProfile()).toBeUndefined()
  })

  it('四项安全边界能存能回填：多行 / 顿号都认，没有忌口就填「无」（FR-1003）', async () => {
    await saveProfile({ ...EXISTING, avoidFoods: ['香菜'], allergies: ['无'], equipment: ['杠铃', '哑铃'], mealMinutes: 25 })
    const wrapper = await mountPage()

    // 第 3 个多行框是「忌口」，第 4 个是「过敏」，第 5 个是「可用器材」
    const areas = wrapper.findAll('textarea')
    expect((areas[2].element as HTMLTextAreaElement).value).toBe('香菜')
    expect((areas[3].element as HTMLTextAreaElement).value).toBe('无')
    expect((areas[4].element as HTMLTextAreaElement).value).toBe('杠铃\n哑铃')
    expect((inputFor(wrapper, '每餐时间(min)').element as HTMLInputElement).value).toBe('25')

    await areas[2].setValue('香菜、内脏\n折耳根')
    await areas[4].setValue('自重')
    await inputFor(wrapper, '每餐时间(min)').setValue('15')
    await button(wrapper, '保存档案').trigger('click')

    await vi.waitFor(async () => {
      expect((await getProfile())?.mealMinutes).toBe(15)
    })
    const saved = (await getProfile()) as ProfileRecord
    expect(saved.avoidFoods).toEqual(['香菜', '内脏', '折耳根'])
    expect(saved.equipment).toEqual(['自重'])
  })

  it('每餐时间的离谱输入被拦下，不写库（FR-1003）', async () => {
    const wrapper = await mountPage()
    await inputFor(wrapper, '年龄').setValue('30')
    await inputFor(wrapper, '身高(cm)').setValue('175')
    await inputFor(wrapper, '体重(kg)').setValue('75')
    await inputFor(wrapper, '每餐时间(min)').setValue('600')
    await button(wrapper, '保存档案').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('每餐时间要填 5-180 分钟')
    })
    expect(await getProfile()).toBeUndefined()
  })

  it('「不再追问」名单写进 settings（澄清引擎读的就是那儿），不是档案里那份死字段', async () => {
    const wrapper = await mountPage()
    await inputFor(wrapper, '年龄').setValue('30')
    await inputFor(wrapper, '身高(cm)').setValue('175')
    await inputFor(wrapper, '体重(kg)').setValue('75')

    // 两个多行输入框：第一个是记录口径约定，第二个是「不再追问」
    const areas = wrapper.findAll('textarea')
    expect(areas.length).toBeGreaterThanOrEqual(2)
    await areas[1].setValue('油.grams\n盐.grams')
    await button(wrapper, '保存档案').trigger('click')

    await vi.waitFor(async () => {
      expect((await getSettings()).mutedFields).toEqual(['油.grams', '盐.grams'])
    })
    // 2026-10-16 前的 bug：名单写进了 profile.mutedFields，澄清引擎读的是 settings，于是输入框形同摆设
    expect('mutedFields' in ((await getProfile()) as ProfileRecord)).toBe(false)
  })
})
