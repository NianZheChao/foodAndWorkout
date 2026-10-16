// @vitest-environment jsdom
/**
 * 数据页（T4.1）：导出能看到条目数与校验和，导入走「选文件 → 预演 → 确认 → 报告」。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import DataPage from '@/pages/DataPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { buildExportPackage, checksumOf, serializeExport } from '@/io/exportPackage'
import { updateDay } from '@/data/repositories/days'
import { addIntake } from '@/data/repositories/intake'
import { enqueue, markOp } from '@/data/repositories/pendingOps'
import { saveModelConfig } from '@/data/repositories/modelConfig'

// 回滚要先弹一个确认框：jsdom 里没人点它，`showDialog` 的 promise 永远不 resolve。
// 只替掉这一个函数，`van-button` 之类的真实组件照旧。
vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return { ...actual, showDialog: vi.fn(async () => undefined) }
})

const DATE = '2026-10-15'

async function mountPage(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/data')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(DataPage, { global: { plugins: [pinia, router] } })
  await vi.waitFor(() => {
    expect(wrapper.find('[data-ready="true"]').exists()).toBe(true)
  })
  return wrapper
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label))
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

async function seed(): Promise<void> {
  await updateDay(DATE, { weightAmKg: 75.1 })
  await addIntake({
    date: DATE,
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食材',
    foodSnapshot: { name: '测试食材', unit: '100g', kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 },
    amount: { qty: 1, unit: '100g', grams: 100 },
    computed: { kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 }
  })
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  // jsdom 里 `<a download>` 的 click 会走"导航到另一个文档"的未实现分支：
  // 替掉它，同时把它当作"确实触发了下载"的证据
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})

describe('数据页：导出', () => {
  it('本地有多少东西看得见；点导出后给出文件名与校验和', async () => {
    await seed()
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('天记录：1')
    expect(wrapper.text()).toContain('条饮食：1')

    await button(wrapper, '导出 JSON').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('薄肌计划-export-')
      expect(wrapper.text()).toContain('校验和')
    })
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()
  })

  it('空库时说明「暂时没有数据」，导出仍然可用', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('本机暂时没有数据')
    await button(wrapper, '导出 JSON').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('校验和'))
  })
})

describe('数据页：导出为工作区格式', () => {
  it('生成文本包，列出包内文件与行数', async () => {
    await seed()
    const wrapper = await mountPage()

    await button(wrapper, '导出工作区文本').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('薄肌计划-工作区-')
    })
    const card = wrapper.findAll('.card').find((item) => item.text().includes('导出为工作区格式'))
    if (!card) throw new Error('找不到「导出为工作区格式」卡片')
    // 没填档案 / 没校准就不生成空壳文件：只有记录与食物库
    expect(card.findAll('li').map((item) => item.text())).toEqual([
      'records/2026-10-15.md',
      'data/foods.csv'
    ])
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()
  })
})

describe('数据页：导入', () => {
  it('选文件 → 预演差异与冲突日 → 确认导入 → 看报告', async () => {
    // 本地先有 10-15，文件里也有 10-15（冲突）与 10-14（新增）
    await seed()
    const pkg = await buildExportPackage()
    const file = { ...pkg }
    file.data = {
      ...pkg.data,
      days: [
        ...pkg.data.days,
        { date: '2026-10-14', weekday: '三', pendingCount: 0, createdAt: 1, updatedAt: 1 }
      ]
    }
    file.checksum = await checksumOf(file.data)

    const wrapper = await mountPage()
    const input = wrapper.find('input[type="file"]')
    const text = serializeExport(file)
    const jsonFile = new File([text], 'export.json', { type: 'application/json' })
    Object.defineProperty(input.element, 'files', { value: [jsonFile], configurable: true })
    await input.trigger('change')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('将要导入')
      expect(wrapper.text()).toContain('冲突日期')
    })
    expect(await db.days.get('2026-10-14')).toBeUndefined()

    await button(wrapper, '确认导入').trigger('click')
    await vi.waitFor(async () => {
      expect(await db.days.get('2026-10-14')).toBeDefined()
    })
    expect(wrapper.text()).toContain('导入报告')
  })
})

describe('数据页：快照与回滚', () => {
  it('拍一张快照 → 列表里看得见 → 回滚后给出「回滚后 / 被替换掉的原状态」', async () => {
    await seed()
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('还没有快照')

    await wrapper.find('input[type="date"]').setValue(DATE)
    await button(wrapper, '拍一张快照').trigger('click')

    const card = () => {
      const found = wrapper.findAll('.card').find((item) => item.text().includes('快照与回滚'))
      if (!found) throw new Error('找不到「快照与回滚」卡片')
      return found
    }
    await vi.waitFor(() => expect(card().text()).toContain('手动快照'))
    expect(card().text()).toContain('饮食 1 条 · 训练 0 条')

    // 之后这一天被改烂了：晨重变了、那条饮食也没了
    await updateDay(DATE, { weightAmKg: 80 })
    await db.intake.clear()
    await button(wrapper, `回滚到 ${DATE}`).trigger('click')

    await vi.waitFor(() => expect(wrapper.text()).toContain('回滚结果'))
    // 快照里的样子
    expect(card().text()).toContain('头部有 · 饮食 1 条 · 训练 0 条')
    // 回滚前本机是什么样（提示用户有没有回滚错版本）
    expect(card().text()).toContain('头部有 · 饮食 0 条 · 训练 0 条')
    const day = await db.days.get(DATE)
    expect(day?.weightAmKg).toBe(75.1)
    expect(await db.intake.count()).toBe(1)
  })
})

describe('数据页：离线队列与诊断信息（T4.6）', () => {
  function card(wrapper: VueWrapper, title: string) {
    const found = wrapper.findAll('.card').find((item) => item.text().includes(title))
    if (!found) throw new Error(`找不到「${title}」卡片`)
    return found
  }

  it('卡住的队列项能看到原因，也能「不再自动重试」', async () => {
    const id = await enqueue('food.resolve', '测试食材')
    await markOp(id, { status: 'needs-attention', attempts: 3, lastError: '模型给的值置信度低' })
    const wrapper = await mountPage()

    expect(card(wrapper, '离线队列').text()).toContain('1 条待处理')
    expect(card(wrapper, '离线队列').text()).toContain('食物补全')
    expect(card(wrapper, '离线队列').text()).toContain('需要你处理')
    expect(card(wrapper, '离线队列').text()).toContain('模型给的值置信度低')
    expect(card(wrapper, '离线队列').text()).toContain('已试 3 次')

    await button(wrapper, '不再自动重试').trigger('click')
    await vi.waitFor(() => {
      expect(card(wrapper, '离线队列').text()).toContain('没有待处理的队列项')
    })
    // 「不再自动重试」只拿掉队列项，记录本身不动
    expect(await db.pendingOps.count()).toBe(0)
  })

  it('诊断信息导出：给出文件名与内容摘要，token 不进页面也不进文件', async () => {
    await saveModelConfig({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret-value',
      model: 'gpt-x',
      enabled: true
    })
    const wrapper = await mountPage()
    await button(wrapper, '导出诊断信息').trigger('click')

    await vi.waitFor(() => {
      expect(card(wrapper, '诊断信息导出').text()).toContain('thin-muscle-plan-diagnostics-')
    })
    expect(card(wrapper, '诊断信息导出').text()).toContain('schema v')
    expect(wrapper.text()).not.toContain('sk-secret-value')
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()
  })
})