// @vitest-environment jsdom
/**
 * 设置页的「提醒」部分（T4.5 / M11 FR-1101 / FR-1104 / TD-09）。
 *
 * 这个页面在 T4.5 里承担一条硬需求：**把提醒的限制写在用户看得见的地方**。
 * 所以除了「改一下就存一下」，这里还钉住三块必须出现的说明：没有服务端（应用关着不响）、
 * 不做日历 / .ics 导出、同一事项一天只响一次。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import SettingsPage from '@/pages/SettingsPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { getSettings, saveSettings } from '@/data/repositories/settings'
import { saveProfile } from '@/data/repositories/profile'
import { REMINDER_DEFAULTS, REMINDER_IDS } from '@/domain/reminders'

async function mountSettings(): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/settings')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(SettingsPage, { global: { plugins: [pinia, router] } })
  // 页面是「读 IndexedDB → 再渲染」，fake-indexeddb 走宏任务，等到五项都出来再断言
  await vi.waitFor(() => {
    expect(wrapper.findAll('input[type="time"]')).toHaveLength(REMINDER_DEFAULTS.length)
  })
  return { wrapper, router }
}

/** 提醒项的开关（T4.5）。T3.8 之后页面上多了一个推荐开关，所以按行收窄。 */
function switches(wrapper: VueWrapper): VueWrapper[] {
  return wrapper.findAll('.reminder-row .van-switch') as unknown as VueWrapper[]
}

function recommendSwitch(wrapper: VueWrapper): VueWrapper {
  const found = wrapper.find('.recommend-card .van-switch')
  if (!found.exists()) throw new Error('找不到推荐开关')
  return found as unknown as VueWrapper
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label))
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

async function savedReminder(id: string) {
  const settings = await getSettings()
  const row = settings.reminders.find((item) => item.id === id)
  if (!row) throw new Error(`库里没有提醒项 ${id}`)
  return row
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  // jsdom 不实现 Notification API；显式清一遍，免得断言依赖环境细节
  ;(globalThis as { Notification?: unknown }).Notification = undefined
})

describe('设置页 · 提醒', () => {
  it('五项提醒都列出来，时间是默认值，开关默认都开着', async () => {
    const { wrapper } = await mountSettings()
    const text = wrapper.text()
    for (const row of REMINDER_DEFAULTS) expect(text).toContain(row.label)

    const times = wrapper.findAll<HTMLInputElement>('input[type="time"]')
    expect(times.map((input) => input.element.value)).toEqual(REMINDER_DEFAULTS.map((row) => row.time))
    expect(switches(wrapper)).toHaveLength(REMINDER_DEFAULTS.length)
    expect(switches(wrapper).every((item) => item.classes().includes('van-switch--on'))).toBe(true)
  })

  it('关掉一项就落库（没有「保存」按钮，也没有重复的默认项）', async () => {
    const { wrapper } = await mountSettings()
    await switches(wrapper)[2].trigger('click')
    await flushPromises()

    expect((await savedReminder(REMINDER_IDS.intake)).enabled).toBe(false)
    expect(await savedReminder(REMINDER_IDS.morningWeight)).toMatchObject({ enabled: true, time: '09:00' })
    // Vant 的开关只有「开着」才加修饰类，关掉后落回光秃秃的 `van-switch`
    expect(switches(wrapper)[2].classes()).not.toContain('van-switch--on')
    expect(switches(wrapper)[0].classes()).toContain('van-switch--on')
    expect((await getSettings()).reminders).toHaveLength(REMINDER_DEFAULTS.length)
  })

  it('改时间就落库，其他项不受影响', async () => {
    const { wrapper } = await mountSettings()
    const input = wrapper.findAll<HTMLInputElement>('input[type="time"]')[0]
    await input.setValue('07:30')
    await input.trigger('change')
    await flushPromises()

    expect((await savedReminder(REMINDER_IDS.morningWeight)).time).toBe('07:30')
    expect((await savedReminder(REMINDER_IDS.eveningWeight)).time).toBe('22:30')
  })

  it('关掉的项，时间输入跟着禁掉（不给「关了还改时间」的错觉）', async () => {
    const { wrapper } = await mountSettings()
    await switches(wrapper)[0].trigger('click')
    await flushPromises()
    const input = wrapper.findAll<HTMLInputElement>('input[type="time"]')[0]
    expect(input.element.disabled).toBe(true)
  })

  it('把限制写在页面上：没有服务端 → 应用关着不响、不做 .ics、一天只响一次', async () => {
    const { wrapper } = await mountSettings()
    const text = wrapper.text()
    expect(text).toContain('没有服务端')
    expect(text).toContain('应用关着的时候也不会响')
    expect(text).toContain('不提供日历')
    expect(text).toContain('一天只会响一次')
  })

  it('设备不支持系统通知时：如实说明，按钮禁用并写清只走应用内提醒', async () => {
    const { wrapper } = await mountSettings()
    expect(wrapper.text()).toContain('本设备不支持系统通知')

    const button = wrapper.findAll('button').find((item) => item.text().includes('本设备不支持系统通知'))
    if (!button) throw new Error('找不到权限按钮')
    expect((button.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('模型设置入口常驻（已有的能力不能被埋掉）', async () => {
    const { wrapper, router } = await mountSettings()
    const entry = wrapper.findAll('button').find((item) => item.text() === '模型设置')
    if (!entry) throw new Error('找不到「模型设置」入口')
    await entry.trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/settings/model')
    })
  })
})

describe('设置页 · 偏好与名单（T4.6）', () => {
  it('单位只说明 kg / kcal，并讲清为什么不换算成斤 / kJ', async () => {
    const { wrapper } = await mountSettings()
    expect(wrapper.text()).toContain('重量 kg · 能量 kcal')
    expect(wrapper.text()).toContain('不换算成斤或 kJ')
  })

  it('周起始日切换落库（它只决定「哪一天算周末」，不影响报告口径）', async () => {
    const { wrapper } = await mountSettings()
    await button(wrapper, '周日').trigger('click')
    await vi.waitFor(async () => {
      expect((await getSettings()).weekStart).toBe(7)
    })
    await button(wrapper, '周一').trigger('click')
    await vi.waitFor(async () => {
      expect((await getSettings()).weekStart).toBe(1)
    })
  })

  it('外观切换立刻生效并落库：深色 → data-theme=dark，浅色 → 回到 light', async () => {
    const { wrapper } = await mountSettings()
    await button(wrapper, '深色').trigger('click')
    await vi.waitFor(async () => {
      expect((await getSettings()).theme).toBe('dark')
    })
    expect(document.documentElement.dataset.theme).toBe('dark')

    await button(wrapper, '浅色').trigger('click')
    await vi.waitFor(async () => {
      expect((await getSettings()).theme).toBe('light')
    })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(wrapper.text()).toContain('跟随系统')
  })

  it('「不再追问」名单列出来，点「恢复追问」就从名单里拿掉（FR-1103）', async () => {
    await saveSettings({ mutedFields: ['油.grams', '盐.grams'] })
    const { wrapper } = await mountSettings()
    expect(wrapper.text()).toContain('油.grams')

    await button(wrapper, '恢复追问').trigger('click')
    await vi.waitFor(async () => {
      expect((await getSettings()).mutedFields).toEqual(['盐.grams'])
    })
    expect(wrapper.text()).not.toContain('油.grams')
  })

  it('名单为空时说「该问的都会问」，并留一条去档案页编辑的路', async () => {
    const { wrapper, router } = await mountSettings()
    expect(wrapper.text()).toContain('名单是空的')

    await button(wrapper, '去档案页编辑名单').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/profile')
    })
  })

  it('关于与免责声明入口能进 /about（FR-1608）', async () => {
    const { wrapper, router } = await mountSettings()
    await button(wrapper, '关于与免责声明').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/about')
    })
  })
})

describe('设置页 · 生成式推荐开关（T3.8 / FR-1003）', () => {
  const CONSTRAINT_PROFILE = {
    id: 'current' as const,
    sex: 'male' as const,
    age: 30,
    heightCm: 175,
    weightKg: 75,
    goal: '减脂' as const,
    trainingLevel: '新手' as const,
    conventions: [],
    avoidFoods: ['香菜'],
    allergies: ['无'],
    equipment: ['杠铃'],
    mealMinutes: 20,
    updatedAt: Date.now()
  }

  it('默认关，且四项约束没填齐时开关是禁用的、点也点不开', async () => {
    const { wrapper } = await mountSettings()
    expect(wrapper.text()).toContain('默认关')
    expect(wrapper.text()).toContain('忌口')
    expect(recommendSwitch(wrapper).classes()).toContain('van-switch--disabled')

    await recommendSwitch(wrapper).trigger('click')
    await flushPromises()
    expect((await getSettings()).recommendEnabled).toBe(false)
    expect(wrapper.text()).toContain('开启前必须先补齐安全边界')
  })

  it('缺哪几项就说哪几项，并留一条去档案页的路', async () => {
    await saveProfile({ ...CONSTRAINT_PROFILE, allergies: [], equipment: [], mealMinutes: undefined })
    const { wrapper, router } = await mountSettings()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('开启前必须先补齐安全边界')
    })
    const text = wrapper.text()
    expect(text).toContain('过敏')
    expect(text).toContain('可用器材')
    expect(text).toContain('每餐时间')
    expect(text).not.toContain('四项约束已齐')

    await button(wrapper, '去档案页填写').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/profile')
    })
  })

  it('四项齐了就能打开，并且落库；再关一次也落库（FR-1003）', async () => {
    await saveProfile(CONSTRAINT_PROFILE)
    const { wrapper } = await mountSettings()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('四项约束已齐')
    })
    expect(recommendSwitch(wrapper).classes()).not.toContain('van-switch--disabled')

    await recommendSwitch(wrapper).trigger('click')
    await vi.waitFor(async () => {
      expect((await getSettings()).recommendEnabled).toBe(true)
    })
    expect(recommendSwitch(wrapper).classes()).toContain('van-switch--on')

    await recommendSwitch(wrapper).trigger('click')
    await vi.waitFor(async () => {
      expect((await getSettings()).recommendEnabled).toBe(false)
    })
    expect(recommendSwitch(wrapper).classes()).not.toContain('van-switch--on')
  })
})
