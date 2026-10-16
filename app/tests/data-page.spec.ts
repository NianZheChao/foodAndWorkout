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
