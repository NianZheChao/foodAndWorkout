// @vitest-environment jsdom
/**
 * 「记录 → 饮食」里的待补全入口（2026-10-19 回归）。
 *
 * 一句话记录把没算出克数的食物先落成占位条目后，用户必须能在记录页点「补齐」，
 * 而不是只剩一个「待补全」标签和删除按钮。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import LogDietPage from '@/pages/LogDietPage.vue'
import { routes } from '@/router'
import { todayIso } from '@/app/date'
import { db } from '@/data/db'
import { upsertFood } from '@/data/repositories/foods'
import { addIntake } from '@/data/repositories/intake'
import { useDayStore } from '@/store/day'

const DATE = todayIso()
const FOOD_NAME = '凯撒沙拉(自制)'

async function seedPending(): Promise<{ foodId: string; entryId: string }> {
  const food = await upsertFood({
    name: FOOD_NAME,
    category: '轻食',
    unit: '100g',
    kcal: 150,
    proteinG: 8,
    fatG: 10,
    carbG: 9,
    fiberG: 2,
    sodiumMg: 320,
    source: 'manual'
  })
  const entryId = await addIntake({
    date: DATE,
    meal: '午餐',
    dish: '凯撒沙拉',
    foodId: '凯撒沙拉',
    foodSnapshot: {
      name: '凯撒沙拉',
      unit: '100g',
      kcal: 0,
      proteinG: 0,
      fatG: 0,
      carbG: 0,
      fiberG: 0,
      sodiumMg: 0
    },
    amount: { qty: 1, unit: '待补全' },
    computed: { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 },
    pendingFlag: 1,
    note: '中午吃了凯撒沙拉'
  })
  return { foodId: food.id, entryId }
}

async function mountPage(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/log/diet')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  await useDayStore().load(DATE)
  const wrapper = mount(LogDietPage, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label))
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

describe('记录 → 饮食：待补全的食物有补齐入口', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map((table) => table.clear()))
  })

  it('从待补全卡片点补齐，选食物库条目并保存后清掉标记、重算数值', async () => {
    const { foodId, entryId } = await seedPending()
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('待补全（1）')
    expect(button(wrapper, '补齐').exists()).toBe(true)

    await button(wrapper, '补齐').trigger('click')
    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('补齐「凯撒沙拉」')
      },
      { timeout: 5000 }
    )

    const result = wrapper.findAll('.complete-results .food-item').find((item) => item.text().includes(FOOD_NAME))
    expect(result, '食物库搜索结果里应有合成条目').toBeTruthy()
    await result?.trigger('click')
    await flushPromises()

    const portion = wrapper.find('input[placeholder="如 200g / 2只 / 一碗"]')
    expect(portion.exists()).toBe(true)
    await portion.setValue('200g')
    await vi.waitFor(
      () => {
        expect(wrapper.text()).toContain('补齐后 ≈ 300 kcal')
      },
      { timeout: 5000 }
    )

    await button(wrapper, '保存补齐').trigger('click')
    await vi.waitFor(
      async () => {
        const row = await db.intake.get(entryId)
        expect(row?.pendingFlag).toBe(0)
        expect(row?.amount.grams).toBe(200)
        expect(row?.computed.kcal).toBeCloseTo(300, 5)
        expect(row?.foodId).toBe(foodId)
      },
      { timeout: 5000 }
    )
    await vi.waitFor(() => {
      expect(wrapper.text()).not.toContain('待补全（1）')
    })
  })
})
