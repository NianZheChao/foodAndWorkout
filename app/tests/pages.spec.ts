// @vitest-environment jsdom
/**
 * 页面挂载 + 底部 tab 导航的回归测试。
 *
 * 这里守着 App.vue 顶部注释里说的两个坑：
 * 1. `/log/*` 必须高亮「记录」，不能因为匹配不上而退回高亮「今日」；
 * 2. 点一个**已经高亮**的 tab 也必须真的跳转 —— Vant 的 `change` 只在选中项变化时触发，
 *    只靠 `change` 会让用户卡在「回不到首页」的死键上。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import App from '@/App.vue'
import { routes } from '@/router'
import { db } from '@/data/db'

async function mountApp(path: string): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(App, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router }
}

function tabItems(wrapper: VueWrapper): VueWrapper[] {
  return wrapper.findAll('.van-tabbar-item') as unknown as VueWrapper[]
}

/** 高亮的底部 tab 下标；一个都没高亮时返回 -1。 */
function activeIndex(wrapper: VueWrapper): number {
  return tabItems(wrapper).findIndex((item) => item.classes().includes('van-tabbar-item--active'))
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('页面挂载（阶段 1 已落地的路由）', () => {
  it.each([
    '/today',
    '/log',
    '/log/diet',
    '/log/workout',
    '/log/body',
    '/log/quick',
    '/summary',
    '/settings/model'
  ])(
    '%s 能挂载并渲染出页面标题',
    async (path) => {
      const { wrapper } = await mountApp(path)
      expect(wrapper.find('.page-title').exists()).toBe(true)
      expect(wrapper.text().length).toBeGreaterThan(0)
    }
  )

  it('「记录」hub 顶部有饮食 / 训练 / 身体三个子 tab，选中项跟着路由走', async () => {
    const { wrapper } = await mountApp('/log/workout')
    const titles = wrapper.findAll('.van-tab').map((tab) => tab.text())
    expect(titles).toEqual(['饮食', '训练', '身体'])
    expect(wrapper.find('.van-tab--active').text()).toBe('训练')
    expect(wrapper.find('.page-title').text()).toBe('记录')
  })
})

describe('底部 tab 导航回归（「无法返回首页」）', () => {
  it('「记录」下的所有子页面都高亮「记录」，不会退回「今日」', async () => {
    for (const path of ['/log', '/log/diet', '/log/workout', '/log/body']) {
      const { wrapper } = await mountApp(path)
      expect(activeIndex(wrapper), path).toBe(1)
    }
  })

  it('「今日」与「当日汇总」都归到「今日」', async () => {
    for (const path of ['/today', '/summary']) {
      const { wrapper } = await mountApp(path)
      expect(activeIndex(wrapper), path).toBe(0)
    }
  })

  it('从 /log/workout 点「今日」能回到首页（本次 bug 的正面用例）', async () => {
    const { wrapper, router } = await mountApp('/log/workout')
    expect(activeIndex(wrapper)).toBe(1)

    await tabItems(wrapper)[0].trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/today')
    expect(activeIndex(wrapper)).toBe(0)
    expect(wrapper.find('.page-title').text()).toBe('薄肌计划')
  })

  it('点一个已经高亮的 tab 也要跳转，不能是死键', async () => {
    // /log/workout 时「记录」是高亮的，点它应回到 hub 根（/log），而不是毫无反应
    const { wrapper, router } = await mountApp('/log/workout')
    expect(activeIndex(wrapper)).toBe(1)

    await tabItems(wrapper)[1].trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/log')
  })

  it('从 /summary 点「今日」也能回首页', async () => {
    const { wrapper, router } = await mountApp('/summary')
    await tabItems(wrapper)[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/today')
  })
})

describe('今日页方格按钮 → 记录 hub', () => {
  it('「记饮食 / 记训练 / 记身体」分别落在对应子 tab', async () => {
    const { wrapper, router } = await mountApp('/today')
    const buttons = () => wrapper.findAll('.quick-grid .van-button')
    expect(buttons().map((button) => button.text())).toEqual([
      '记饮食',
      '记训练',
      '记身体',
      '一句话记录',
      '当日汇总'
    ])

    await buttons()[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/log/diet')

    await router.push('/today')
    await flushPromises()
    await buttons()[1].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/log/workout')

    await router.push('/today')
    await flushPromises()
    await buttons()[2].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/log/body')
  })

  it('hub 子 tab 切换会把路由参数一起改掉', async () => {
    const { wrapper, router } = await mountApp('/log/diet')
    await wrapper.findAll('.van-tab')[1].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/log/workout')
    expect(wrapper.find('.page-title').text()).toBe('记录')
  })
})
