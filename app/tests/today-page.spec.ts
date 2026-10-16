// @vitest-environment jsdom
/**
 * 启动链路：`initializeApp()` 写种子食物库，今日页正常渲染。
 *
 * 「本机数据」（食物库条目 / 种子版本 / schema）那张卡片 2026-10-16 挪去了「我的」页
 * （今日页只管今天），它的数字断言跟着搬到了 `tests/me-page.spec.ts`。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import TodayPage from '@/pages/TodayPage.vue'
import { initializeApp } from '@/app/bootstrap'
import { db } from '@/data/db'
import { countFoods } from '@/data/repositories/foods'
import { foodSeed } from '@/data/seed'
import { routes } from '@/router'

const router = createRouter({ history: createMemoryHistory(), routes })

function mountToday() {
  return mount(TodayPage, { global: { plugins: [createPinia(), router] } })
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('启动链路（bootstrap + 今日页）', () => {
  it('首次启动写入种子食物库，今日页把当天的骨架渲染出来', async () => {
    const report = await initializeApp()
    expect(report.firstRun).toBe(true)
    expect(report.seeded).toBe(foodSeed.length)
    expect(await countFoods()).toBe(foodSeed.length)

    const wrapper = mountToday()
    // 页面里是「读 IndexedDB → 再读 IndexedDB」的链式 await，
    // 单靠 flushPromises 挡不住 fake-indexeddb 的宏任务，用 waitFor 更稳。
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('今日进度')
    })
    expect(wrapper.text()).toContain('今日指导')
  })

  it('再次启动不重复写入（幂等）', async () => {
    await initializeApp()
    const second = await initializeApp()
    expect(second.firstRun).toBe(false)
    expect(second.seeded).toBe(0)
    expect(await countFoods()).toBe(foodSeed.length)
  })
})