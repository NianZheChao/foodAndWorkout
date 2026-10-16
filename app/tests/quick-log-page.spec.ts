// @vitest-environment jsdom
/**
 * 「一句话 / 拍照记录」的端到端用例（DR-44 / DR-47 / §6.11）。
 *
 * 串起来验证：任意描述 → 草稿 → 澄清卡片 → 落库。模型全部用替身，
 * 重点看本地这部分行为是否守规矩：估不准要问、问完要能算、算不出也不能卡住记录。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import LogQuickPage from '@/pages/LogQuickPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { listIntakeByDate } from '@/data/repositories/intake'
import { listOpenDrafts } from '@/data/repositories/drafts'
import { saveModelConfig } from '@/data/repositories/modelConfig'
import { seedFoods, upsertFood } from '@/data/repositories/foods'
import { FOOD_SEED_VERSION, foodSeed } from '@/data/seed'
import { todayIso } from '@/app/date'
import { useDraftStore } from '@/store/draft'
import { fakeResponse } from './helpers/llm'

const TEXT = '今天中午吃了一顿西红柿鸡蛋拌面，4个西红柿，5个鸡蛋，80g干重的干面条，油盐正常量'
const DATE = todayIso()

const parsePayload = {
  kind: 'intake',
  meal: '午餐',
  dish: '西红柿鸡蛋拌面',
  items: [
    { food: '西红柿', amountText: '4个', grams: 600, pending: false, confidence: 'medium' },
    { food: '鸡蛋(全蛋 生)', amountText: '5个', grams: null, pending: false, confidence: 'high' },
    { food: '面条(干)', amountText: '80g', grams: 80, pending: false, confidence: 'high' },
    { food: '食用油', amountText: '正常量', grams: null, pending: true, confidence: 'low' }
  ],
  clarify: [],
  assumptions: [],
  uncertain: ['油盐用量'],
  rawText: TEXT
}

/** 依请求体形状分流：带 items[].text 的是 food.resolve，否则是 log.parse。 */
function routedFetch(): typeof fetch {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { items?: { text?: string }[] }
    const isFoodResolve = !!body.items?.[0]?.text
    const content = isFoodResolve
      ? JSON.stringify({ items: [{ query: body.items?.[0]?.text, matched: false }] })
      : JSON.stringify(parsePayload)
    return fakeResponse({ choices: [{ message: { content } }], model: 'stub' })
  }) as unknown as typeof fetch
}

async function mountPage() {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/log/quick?kind=intake')
  await router.isReady()
  const wrapper = mount(LogQuickPage, { global: { plugins: [createPinia(), router] } })
  await flushPromises()
  return wrapper
}

function button(wrapper: Awaited<ReturnType<typeof mountPage>>, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text() === label)
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  await seedFoods(foodSeed, FOOD_SEED_VERSION)
  await upsertFood({
    name: '鸡蛋(全蛋 生)',
    category: '蛋奶',
    unit: '100g',
    kcal: 144,
    proteinG: 13.3,
    fatG: 8.8,
    carbG: 2.8,
    fiberG: 0,
    sodiumMg: 131,
    portions: [{ label: '1个', grams: 50 }],
    source: 'seed'
  })
  await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'stub' })
  vi.stubGlobal('fetch', routedFetch())
})

describe('一句话记录：草稿 → 澄清 → 落库', () => {
  it('解析后生成草稿、把能本地折算的补上、把算不出的问出来', async () => {
    const wrapper = await mountPage()
    await wrapper.find('textarea').setValue(TEXT)
    await button(wrapper, '解析').trigger('click')

    await vi.waitFor(
      async () => {
        expect(await listOpenDrafts(DATE)).toHaveLength(1)
        // 「5个鸡蛋」用库里的 1个 = 50g 折算，不问
        expect(wrapper.text()).toContain('250 g')
      },
      { timeout: 5000 }
    )
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('西红柿鸡蛋拌面')
    // 食用油没有克重 → 必须问
    expect(text).toContain('食用油')
    expect(text).toContain('先确认这几项')

    expect((await listOpenDrafts(DATE))[0].intake[1]).toMatchObject({ food: '鸡蛋(全蛋 生)', grams: 250 })
  })

  it('回答澄清后用回答的克数落库；算不出的标「待补全」但不阻塞', async () => {
    const wrapper = await mountPage()
    await wrapper.find('textarea').setValue(TEXT)
    await button(wrapper, '解析').trigger('click')
    await vi.waitFor(
      async () => {
        expect(await listOpenDrafts(DATE)).toHaveLength(1)
      },
      { timeout: 5000 }
    )
    await flushPromises()

    // 食用油没有克重、也不是库里的条目：这里点一个本地给出的备选值
    await button(wrapper, '共 100g').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已回答')

    await button(wrapper, '保存到今天的记录').trigger('click')
    await vi.waitFor(
      async () => {
        expect(await listIntakeByDate(DATE)).toHaveLength(4)
      },
      { timeout: 5000 }
    )
    await flushPromises()

    // 库里还没有 西红柿 / 面条(干) / 食用油 的数值：先记下来标待补全，不卡住记录。
    // 「待补全」是逐条写完记录后另写一次的（`day.markPending`）：四条记录齐了不代表
    // 标记也齐了，并行跑时最后一条可能还差一拍，所以这条断言本身也要等（见 §8）。
    await vi.waitFor(
      async () => {
        const current = await listIntakeByDate(DATE)
        expect(current.filter((row) => row.pendingFlag === 1).length).toBe(3)
      },
      { timeout: 5000 }
    )

    const rows = await listIntakeByDate(DATE)
    const oil = rows.find((row) => row.foodSnapshot.name === '食用油')
    expect(oil?.amount.grams).toBe(100)
    const egg = rows.find((row) => row.foodSnapshot.name === '鸡蛋(全蛋 生)')
    expect(egg?.computed.kcal).toBeCloseTo(144 * 2.5, 5)
    expect(egg?.pendingFlag).toBeUndefined()

    // 草稿落库后即清除：删除草稿是 `commit()` 的最后一步独立写（`deleteDraft`），
    // 上面那条 `waitFor` 只等到「待补全」标完 —— 并行跑时这一拍读事务仍可能开在删除提交之前，
    // 所以这条也要轮询等（同 §8 记的那类竞态）。
    await vi.waitFor(
      async () => {
        expect(await listOpenDrafts(DATE)).toHaveLength(0)
      },
      { timeout: 5000 }
    )
    // 算不出的三条都明确提示「待补全」，记录本身照写不误
    expect(wrapper.text()).toContain('待补全')
  })

  it('解析失败时保留原文，不丢用户的描述', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch
    )
    const wrapper = await mountPage()
    await wrapper.find('textarea').setValue(TEXT)
    await button(wrapper, '解析').trigger('click')

    await vi.waitFor(
      async () => {
        expect(await listOpenDrafts(DATE)).toHaveLength(1)
      },
      { timeout: 5000 }
    )
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('这次没解析成功')
    })
    expect((await listOpenDrafts(DATE))[0].rawText).toBe(TEXT)
  })

  it('模型不支持图片时引导「改用文字」或「换模型」，不是只报一句错（T2.7）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ error: { message: 'image input is not supported' } }, 400)) as unknown as typeof fetch
    )
    const wrapper = await mountPage()
    // 图片压缩在 jsdom 里跑不动，这里直接驱动 store：验证的是「失败分类 → 引导文案」这一段
    await useDraftStore().submit({
      date: DATE,
      text: '拍了一张午饭',
      kind: 'intake',
      images: ['data:image/jpeg;base64,AAAA']
    })
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('改用文字描述')
    })
    expect(wrapper.text()).toContain('去模型设置')
    expect(wrapper.text()).toContain('去掉图片，用文字重试')
  })
})
