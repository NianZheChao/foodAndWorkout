// @vitest-environment jsdom
/**
 * 页面挂载 + 底部 tab / 页头导航条的回归测试。
 *
 * 这里守着三件事（前两件都是踩过的坑）：
 * 1. **每个页面都落在某个域里**：`/log/*` 与 `/foods` 归「记录」、`/reports/:id` 归「分析」……
 *    重构前有七个页面不属于任何分组，走进去连高亮都没有（用户的原话：页面很零散）。
 * 2. 点一个**已经高亮**的 tab 也必须真的跳转 —— Vant 的 `change` 只在选中项变化时触发，
 *    只靠 `change` 会让用户卡在「回不到首页」的死键上。
 * 3. 页头那条**域导航条**（由 `app/nav.ts` 渲染）在每个页面都能看到：同级页面不再是
 *    只能靠某个按钮进的孤岛（`/coach` 以前就是这样）。
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

/** 按文案找按钮（`includes` 匹配，容忍前后空白）。 */
function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label))
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

/** 页头域导航条里的某一颗格子（按文案精确匹配）。 */
function chip(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('.domain-nav .nav-chip').find((item) => item.text() === label)
  if (!found) throw new Error(`导航条里没有「${label}」`)
  return found
}

function onChips(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.domain-nav .nav-chip')
    .filter((item) => item.classes().includes('nav-chip--on'))
    .map((item) => item.text())
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
    '/trend',
    '/coach',
    '/plan',
    '/reports',
    '/reports/rep_missing',
    '/foods',
    '/targets',
    '/calibration',
    '/me',
    '/profile',
    '/data',
    '/settings',
    '/about',
    '/settings/model'
  ])(
    '%s 能挂载并渲染出页面标题',
    async (path) => {
      const { wrapper } = await mountApp(path)
      expect(wrapper.find('.page-title').exists()).toBe(true)
      expect(wrapper.text().length).toBeGreaterThan(0)
    }
  )
})

describe('底部 tab：五个域（今日 / 记录 / 分析 / 我的 / 设置）', () => {
  it('文案与顺序是一句话能背下来的五个域', async () => {
    const { wrapper } = await mountApp('/today')
    expect(tabItems(wrapper).map((item) => item.text())).toEqual(['今日', '记录', '分析', '我的', '设置'])
  })

  it('每个页面都高亮它所属的域（重构前有七个页面一个都不亮）', async () => {
    const expectations: [string, number][] = [
      ['/today', 0],
      ['/summary', 0],
      ['/coach', 0],
      ['/plan', 0],
      ['/log', 1],
      ['/log/diet', 1],
      ['/log/workout', 1],
      ['/log/body', 1],
      ['/log/quick', 1],
      ['/foods', 1],
      ['/trend', 2],
      ['/reports', 2],
      ['/reports/rep_missing', 2],
      ['/targets', 2],
      ['/calibration', 2],
      ['/me', 3],
      ['/profile', 3],
      ['/data', 3],
      ['/about', 3],
      ['/settings', 4],
      ['/settings/model', 4]
    ]

    for (const [path, index] of expectations) {
      const { wrapper } = await mountApp(path)
      expect(activeIndex(wrapper), path).toBe(index)
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
    // /log/workout 时「记录」是高亮的，点它应回到域根（饮食面板 /log/diet），而不是毫无反应
    const { wrapper, router } = await mountApp('/log/workout')
    expect(activeIndex(wrapper)).toBe(1)

    await tabItems(wrapper)[1].trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/log/diet')
  })

  it('旧的 /log 地址转到域根：不会因为改地址把老链接作废', async () => {
    const { wrapper, router } = await mountApp('/log')
    expect(router.currentRoute.value.path).toBe('/log/diet')
    expect(wrapper.find('.page-title').text()).toBe('饮食')
  })

  it('从 /summary 点「今日」也能回首页', async () => {
    const { wrapper, router } = await mountApp('/summary')
    await tabItems(wrapper)[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/today')
  })
})

describe('页头域导航条（同级页面都在这一行）', () => {
  it('「记录」域列出五个入口，当前面板高亮，点了真的换面板', async () => {
    // 域根就是饮食面板：不再有「记录」「饮食」两颗指向同一页的格子（2026-10-16）
    const { wrapper, router } = await mountApp('/log/diet')
    expect(wrapper.findAll('.domain-nav .nav-chip').map((item) => item.text())).toEqual([
      '饮食',
      '训练',
      '身体',
      '一句话记录',
      '食物库'
    ])
    expect(onChips(wrapper)).toEqual(['饮食'])

    await chip(wrapper, '训练').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/log/workout')
    expect(wrapper.find('.page-title').text()).toBe('训练')
    expect(onChips(wrapper)).toEqual(['训练'])
  })

  it('今日页的导航条给出当日汇总 / 今日指导 / 推荐清单（不依赖有没有生成过）', async () => {
    const { wrapper, router } = await mountApp('/today')
    expect(wrapper.text()).not.toContain('待补全队列')
    expect(wrapper.findAll('.domain-nav .nav-chip').map((item) => item.text())).toEqual([
      '今日',
      '当日汇总',
      '今日指导',
      '推荐清单'
    ])

    const expected: [string, string][] = [
      ['当日汇总', '/summary'],
      ['今日指导', '/coach'],
      ['推荐清单', '/plan']
    ]
    for (const [label, path] of expected) {
      await router.push('/today')
      await flushPromises()
      await chip(wrapper, label).trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path, label).toBe(path)
    }
  })

  it('每个页面都看得到自己所在的分支，且恰好一个「当前」', async () => {
    for (const path of ['/coach', '/log/quick', '/foods', '/reports/rep_missing', '/me', '/settings/model']) {
      const { wrapper } = await mountApp(path)
      expect(wrapper.findAll('.domain-nav .nav-chip').length, path).toBeGreaterThan(1)
      expect(onChips(wrapper).length, path).toBe(1)
    }
  })

  it('报告详情是三级页面：面包屑 分析 › 报告 › 报告详情，上级格子高亮', async () => {
    const { wrapper } = await mountApp('/reports/rep_missing')
    expect(wrapper.find('.crumbs').text().replace(/\s+/g, '')).toBe('分析›报告›报告详情')
    expect(onChips(wrapper)).toEqual(['报告'])
  })

  it('两级页面不重复画面包屑（高亮的格子已经说明位置）', async () => {
    const { wrapper } = await mountApp('/coach')
    expect(wrapper.find('.crumbs').exists()).toBe(false)
  })
})

describe('今日页方格按钮 → 记录 hub', () => {
  it('「记饮食 / 记训练 / 记身体」分别落在对应面板', async () => {
    const { wrapper, router } = await mountApp('/today')
    const buttons = () => wrapper.findAll('.entry-grid .van-button')
    expect(buttons().map((button) => button.text())).toEqual(['记饮食', '记训练', '记身体', '一句话记录'])

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
})

describe('导航可达性（页面不能是孤岛）', () => {
  it('不依赖任何状态就能进模型设置：底部「设置」+ 设置页常驻入口（2026-10-15 回归）', async () => {
    // 那次事故：入口只剩「待补全队列」卡片里那个按钮，而卡片只在队列非空时渲染，
    // 于是正常状态下整个应用都进不去模型设置。现在它挂在「设置」域里（tab + 导航条双保险）。
    const { wrapper, router } = await mountApp('/today')
    expect(wrapper.text()).not.toContain('待补全队列')

    await tabItems(wrapper)[4].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/settings')
    expect(wrapper.find('.page-title').text()).toBe('设置')

    await button(wrapper, '模型设置').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/settings/model')
  })

  it('今日页常驻「今日指导」入口（不依赖今天有没有生成过）', async () => {
    const { wrapper, router } = await mountApp('/today')
    expect(wrapper.text()).toContain('今日指导')
    await button(wrapper, '生成今日指导').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/coach')
  })

  it('二级页面都带返回按钮，点了回到来源页', async () => {
    for (const path of ['/targets', '/profile', '/foods', '/settings/model', '/log/quick', '/data', '/coach']) {
      const { wrapper, router } = await mountApp('/today')
      await router.push(path)
      await flushPromises()
      const back = wrapper.find('.back-btn')
      expect(back.exists(), `${path} 缺少返回按钮`).toBe(true)

      await back.trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path, `${path} 返回后`).toBe('/today')
    }
  })
})

