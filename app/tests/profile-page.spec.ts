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
  age: 26,
  heightCm: 173,
  weightKg: 88,
  goal: '减脂',
  trainingLevel: '新手',
  injuries: '无',
  allergies: '无',
  dietType: '无特殊',
  dailyCookMinutes: 30,
  wakeTime: '09:00',
  sleepTime: '01:00',
  seasonings: { 盐: true },
  equipment: ['哑铃'],
  conventions: ['不记录饮水'],
  mutedFields: [],
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

  it('保存时把性别 / 目标 / 忌口 / 器材 / 约定一起写进本机（FR-1001 / FR-1003 / FR-1004）', async () => {
    const wrapper = await mountPage()
    await inputFor(wrapper, '年龄').setValue('26')
    await inputFor(wrapper, '身高(cm)').setValue('173')
    await inputFor(wrapper, '体重(kg)').setValue('88')
    await inputFor(wrapper, '过敏原').setValue('花生')
    await inputFor(wrapper, '每餐可做饭(分钟)').setValue('25')

    const equipment = wrapper.findAll('.van-checkbox').filter((item) => item.text() === '哑铃')
    await equipment[0].trigger('click')

    await button(wrapper, '保存档案').trigger('click')

    await vi.waitFor(async () => {
      expect(await getProfile()).toBeDefined()
    })
    const saved = (await getProfile()) as ProfileRecord
    expect(saved.age).toBe(26)
    expect(saved.heightCm).toBe(173)
    expect(saved.weightKg).toBe(88)
    expect(saved.allergies).toBe('花生')
    expect(saved.dailyCookMinutes).toBe(25)
    expect(saved.equipment).toEqual(['哑铃'])
    expect(saved.conventions.some((line) => line.includes('不记录饮水'))).toBe(true)
    expect(saved.seasonings['盐']).toBe(false)
    // 调味料表里每一项都要有明确的 true/false，推荐模块才知道「没有」
    expect(Object.keys(saved.seasonings).length).toBeGreaterThan(5)
  })

  it('已有档案时回填原值，改完再存不会丢字段', async () => {
    await saveProfile(EXISTING)
    const wrapper = await mountPage()
    expect((inputFor(wrapper, '身高(cm)').element as HTMLInputElement).value).toBe('173')
    expect((inputFor(wrapper, '起床时间').element as HTMLInputElement).value).toBe('09:00')

    await inputFor(wrapper, '每餐可做饭(分钟)').setValue('40')
    await button(wrapper, '保存档案').trigger('click')
    await vi.waitFor(async () => {
      expect((await getProfile())?.dailyCookMinutes).toBe(40)
    })
    const saved = (await getProfile()) as ProfileRecord
    expect(saved.equipment).toEqual(['哑铃'])
    expect(saved.wakeTime).toBe('09:00')
  })

  it('年龄 / 身高 / 体重的离谱输入被拦下，不写库（BR-16）', async () => {
    const wrapper = await mountPage()
    await inputFor(wrapper, '年龄').setValue('26')
    await inputFor(wrapper, '身高(cm)').setValue('173')
    await inputFor(wrapper, '体重(kg)').setValue('500')
    await button(wrapper, '保存档案').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('体重要填 25-300 kg')
    })
    expect(await getProfile()).toBeUndefined()
  })
})
