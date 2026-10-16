// @vitest-environment jsdom
/**
 * 报告页（T3.3）：列表 → 生成 → 详情 → 编辑 / 重新生成。
 *
 * 重点看三件用户能看见的事：文字没生成时数值区照样在、待核对的数字被高亮、
 * 「重新生成」不覆盖旧版本。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import ReportsPage from '@/pages/ReportsPage.vue'
import ReportDetailPage from '@/pages/ReportDetailPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { addIntake } from '@/data/repositories/intake'
import { updateDay } from '@/data/repositories/days'
import { listReports } from '@/data/repositories/reports'
import { putTargets } from '@/data/repositories/targets'
import { saveModelConfig } from '@/data/repositories/modelConfig'
import { addDays, todayIso } from '@/app/date'
import { chatOk, stubFetch } from './helpers/llm'

const TODAY = todayIso()

function reportJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: '本期一句话。',
    training: { assessment: '未达标', notes: [] },
    diet: { assessment: '基本达标', notes: [] },
    recovery: { notes: [] },
    findings: [{ kind: 'fact', text: '日均摄入 1700 kcal。' }],
    issues: [],
    actions: ['继续记录'],
    calibration: { recommended: false, deltaKcal: 0, rationale: '' },
    disclaimer: '仅供参考。',
    ...patch
  })
}

async function mountAt(path: string, component: unknown): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(component as never, { global: { plugins: [pinia, router] } })
  await vi.waitFor(() => {
    expect(wrapper.find('[data-ready="true"]').exists()).toBe(true)
  })
  return { wrapper, router }
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label))
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

/** 造最近 3 天的体重；`intakeDays` 决定其中几天有饮食记录（用于调覆盖率）。 */
async function seedDays(intakeDays = 2): Promise<void> {
  const rows: [number, number, number | undefined][] = [
    [-3, 71, intakeDays >= 1 ? 1800 : undefined],
    [-2, 70.6, intakeDays >= 2 ? 1600 : undefined],
    [-1, 70.2, undefined]
  ]
  for (const [offset, weight, kcal] of rows) {
    const date = addDays(TODAY, offset)
    await updateDay(date, { weightAmKg: weight })
    if (kcal === undefined) continue
    await addIntake({
      date,
      meal: '午餐',
      dish: '测试餐',
      foodId: '测试食材',
      foodSnapshot: {
        name: '测试食材',
        unit: '100g',
        kcal,
        proteinG: 80,
        fatG: 40,
        carbG: 100,
        fiberG: 10,
        sodiumMg: 1000
      },
      amount: { qty: 1, unit: '100g', grams: 100 },
      computed: { kcal, proteinG: 80, fatG: 40, carbG: 100, fiberG: 10, sodiumMg: 1000 }
    })
  }
}

/** 生成一份报告并打开详情页，返回详情页 wrapper。 */
async function generateAndOpen(summary = '本期平均每天多吃了 380 kcal。'): Promise<VueWrapper> {
  await seedDays()
  await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'stub' })
  vi.stubGlobal('fetch', stubFetch([chatOk(reportJson({ summary }))]).fetchImpl)

  const list = await mountAt('/reports', ReportsPage)
  await button(list.wrapper, '本周').trigger('click')
  await vi.waitFor(async () => {
    expect((await listReports()).length).toBe(1)
  })
  const id = (await listReports())[0].id
  const detail = await mountAt(`/reports/${id}`, ReportDetailPage)
  return detail.wrapper
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  await putTargets({
    tdeeKcal: 2633,
    kcalTarget: 2100,
    proteinTargetG: 140,
    fatTargetG: 70,
    carbTargetG: 270,
    fiberTargetG: 30,
    sodiumMaxMg: 2000,
    weeklyTrainingDays: 3,
    weeklySetsPerMuscle: 10,
    targetWeightKg: 65,
    targetRateKgPerWeek: -0.39,
    reviewCadence: 'weekly'
  })
})

describe('报告列表页', () => {
  it('没有报告时给空状态与两个生成入口', async () => {
    const { wrapper } = await mountAt('/reports', ReportsPage)
    expect(wrapper.text()).toContain('还没有报告')
    const labels = wrapper.findAll('.entry-grid button').map((item) => item.text())
    expect(labels[0]).toContain('本周')
    expect(labels[1]).toContain('本月')
  })

  it('未配模型时先生成数值区，并说清楚文字为什么没生成', async () => {
    await seedDays()
    const { wrapper } = await mountAt('/reports', ReportsPage)
    await button(wrapper, '本周').trigger('click')

    await vi.waitFor(async () => {
      expect((await listReports()).length).toBe(1)
    })
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('数值区已经算好并保存')
    })
    // 列表那一条是 `generate()` 里 `await load()` 之后才渲染的，可能比通知文案晚一拍（见 §8）
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('待生成文字')
    })
    const saved = (await listReports())[0]
    expect(saved.status).toBe('pending')
    expect(saved.digest.intake.avgKcal).toBeCloseTo(1700, 1)
  })

  it('配好模型后生成成功，直接进详情页', async () => {
    await seedDays()
    await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'stub' })
    vi.stubGlobal('fetch', stubFetch([chatOk(reportJson())]).fetchImpl)

    const { wrapper, router } = await mountAt('/reports', ReportsPage)
    await button(wrapper, '本周').trigger('click')

    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toMatch(/^\/reports\/rep_/)
    })
  })
})

describe('报告详情页', () => {
  it('数值区给出本地算出来的数，文字区标出待核对数字', async () => {
    const wrapper = await generateAndOpen()
    const text = wrapper.text()

    expect(text).toContain('数值区（本地计算）')
    expect(text).toContain('日均摄入')
    // 摘要 v2 的三块新数字要真的显示出来（2026-10-16）
    expect(text).toContain('钠 / 纤维')
    expect(text).toContain('训练强度 / 有氧')
    expect(text).toContain('恢复（睡眠 / 精力 / 酸痛）')
    expect(text).toContain('文字区（模型写）')
    // 380 不在摘要里：正文里被高亮出来
    const flagged = wrapper.findAll('.flagged').map((item) => item.text())
    expect(flagged).toContain('380')
    expect(text).toContain('可核对数字')
  })

  it('样本不足时顶部提示，且不给校准建议', async () => {
    // 4 天区间里只有 1 天有记录 = 25% < 50%，触发覆盖率门禁
    await seedDays(1)
    await saveModelConfig({ baseUrl: 'https://example.com/v1', apiKey: 'sk-test', model: 'stub' })
    vi.stubGlobal(
      'fetch',
      stubFetch([
        chatOk(reportJson({ calibration: { recommended: true, deltaKcal: -100, rationale: '实测偏高' } }))
      ]).fetchImpl
    )
    const list = await mountAt('/reports', ReportsPage)
    await button(list.wrapper, '本周').trigger('click')
    await vi.waitFor(async () => {
      expect((await listReports()).length).toBe(1)
    })

    const id = (await listReports())[0].id
    const { wrapper } = await mountAt(`/reports/${id}`, ReportDetailPage)
    expect(wrapper.text()).toContain('样本不足')
    expect(wrapper.text()).toContain('本次不建议调整')
  })

  it('编辑文字后留痕，数值区不动', async () => {
    const wrapper = await generateAndOpen()
    await button(wrapper, '编辑文字').trigger('click')
    await flushPromises()

    await wrapper.find('textarea').setValue('我自己改的总结。')
    await button(wrapper, '保存修改').trigger('click')

    await vi.waitFor(async () => {
      const saved = (await listReports())[0]
      expect(saved.editedByUser).toBe(true)
      expect(saved.content?.summary).toBe('我自己改的总结。')
    })
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('已人工编辑')
    })
    // 数值区仍然来自本地摘要
    expect((await listReports())[0].digest.intake.avgKcal).toBeCloseTo(1700, 1)
  })

  it('重新生成会新建一版，旧版本还在（FR-710）', async () => {
    const wrapper = await generateAndOpen()
    vi.stubGlobal('fetch', stubFetch([chatOk(reportJson({ summary: '第二版。' }))]).fetchImpl)

    await button(wrapper, '重新生成').trigger('click')
    await vi.waitFor(async () => {
      expect((await listReports()).length).toBe(2)
    })
  })
})
