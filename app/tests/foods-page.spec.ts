// @vitest-environment jsdom
/**
 * 食物库页（T4.4）：检索 → 来源筛选 → 停用 / 删除，以及「被引用的删不掉」在界面上的样子。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import FoodsPage from '@/pages/FoodsPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { upsertFood, type UpsertFoodInput } from '@/data/repositories/foods'
import { addIntake } from '@/data/repositories/intake'
import type { FoodSource, IntakeEntry } from '@/domain/types'

// 删除要先弹确认框：jsdom 里没人点它，`showDialog` 的 promise 永远不 resolve。
// 只替掉这一个函数，`van-button` / `van-field` 之类的真实组件照旧。
vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return { ...actual, showDialog: vi.fn(async () => undefined) }
})

const EGG = '鸡蛋(全蛋 生)'
const BOILED_EGG = '鸡蛋(水煮)'
const WHOLE_MILK = '牛奶(全脂 市售)'
const SKIM_MILK = '牛奶(脱脂 市售)'
const CHICKEN = '鸡胸肉'

function foodInput(name: string, source: FoodSource, patch: Partial<UpsertFoodInput> = {}): UpsertFoodInput {
  return {
    name,
    category: '蛋奶',
    unit: '100g',
    kcal: 144,
    proteinG: 13.3,
    fatG: 8.8,
    carbG: 2.8,
    fiberG: 0,
    sodiumMg: 131,
    source,
    ...patch
  }
}

function intakeOf(foodId: string): Omit<IntakeEntry, 'id'> {
  return {
    date: '2026-10-15',
    meal: '午餐',
    dish: '测试餐',
    foodId,
    foodSnapshot: { name: foodId, unit: '100g', kcal: 144, proteinG: 13.3, fatG: 8.8, carbG: 2.8, fiberG: 0, sodiumMg: 131 },
    amount: { qty: 100, unit: 'g', grams: 100 },
    computed: { kcal: 144, proteinG: 13.3, fatG: 8.8, carbG: 2.8, fiberG: 0, sodiumMg: 131 }
  }
}

async function seedLibrary(withReference = true): Promise<void> {
  await upsertFood(foodInput(EGG, 'seed'))
  await upsertFood(foodInput(BOILED_EGG, 'seed'))
  await upsertFood(foodInput(WHOLE_MILK, 'llm', { kcal: 65, proteinG: 3.3, fatG: 3.6, carbG: 4.9, sodiumMg: 60 }))
  await upsertFood(foodInput(SKIM_MILK, 'llm', { kcal: 35, proteinG: 3.4, fatG: 0.2, carbG: 5, sodiumMg: 60 }))
  await upsertFood(foodInput(CHICKEN, 'manual', { category: '肉禽', kcal: 133, proteinG: 24, fatG: 3, carbG: 1 }))
  if (withReference) await addIntake(intakeOf(EGG))
}

async function mountPage(): Promise<VueWrapper> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/foods')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(FoodsPage, { global: { plugins: [pinia, router] } })
  await vi.waitFor(() => {
    expect(wrapper.find('[data-ready="true"]').exists()).toBe(true)
  })
  return wrapper
}

function rowOf(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const found = wrapper.findAll('.food-row').find((item) => item.text().includes(name))
  if (!found) throw new Error(`列表里没有「${name}」`)
  return found
}

function buttonOf(row: DOMWrapper<Element>, label: string): DOMWrapper<Element> {
  const found = row.findAll('button').find((item) => item.text().trim() === label)
  if (!found) throw new Error(`这一行没有「${label}」按钮`)
  return found
}

async function pickChip(wrapper: VueWrapper, label: string): Promise<void> {
  const chip = wrapper.findAll('.chip').find((item) => item.text().trim() === label)
  if (!chip) throw new Error(`找不到筛选项「${label}」`)
  await chip.trigger('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('食物库页', () => {
  it('概况：总数 / 来源分布 / 停用与被引用数一次说清', async () => {
    await seedLibrary()
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('共 5 条 · 内置 2 · 模型 2 · 手工 1')
    expect(wrapper.text()).toContain('已停用 0 条 · 被记录引用过 1 条')
    // 「疑似重复」卡片 2026-10-16 下线：这里不再渲染任何按名字分组的提醒
    expect(wrapper.text()).not.toContain('疑似重复')
  })

  it('检索按名称过滤；每个条目都写明被多少条记录引用', async () => {
    await seedLibrary()
    const wrapper = await mountPage()
    expect(wrapper.findAll('.food-row')).toHaveLength(5)

    await wrapper.find('input').setValue('牛奶')
    await vi.waitFor(() => {
      expect(wrapper.findAll('.food-row')).toHaveLength(2)
    })
    expect(wrapper.text()).toContain('命中 2 条')

    await wrapper.find('input').setValue('')
    await vi.waitFor(() => {
      expect(rowOf(wrapper, EGG).text()).toContain('被 1 条记录引用过')
    })
    expect(rowOf(wrapper, BOILED_EGG).text()).toContain('还没有记录用过')
  })

  it('被引用的条目删除按钮是禁用的，界面也说明了该改用停用', async () => {
    await seedLibrary()
    const wrapper = await mountPage()

    const referenced = rowOf(wrapper, EGG)
    expect((buttonOf(referenced, '删除').element as HTMLButtonElement).disabled).toBe(true)
    expect(referenced.text()).toContain('删不掉（FR-412）')
    // 没被引用的可以删
    expect((buttonOf(rowOf(wrapper, CHICKEN), '删除').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('停用后从列表消失，切到「已停用」还能找到并恢复', async () => {
    await seedLibrary()
    const wrapper = await mountPage()

    await buttonOf(rowOf(wrapper, BOILED_EGG), '停用').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('.food-row').some((item) => item.text().includes(BOILED_EGG))).toBe(false)
    })
    expect(await db.foods.get(BOILED_EGG)).toMatchObject({ disabledFlag: 1 })

    await pickChip(wrapper, '已停用')
    await vi.waitFor(() => {
      expect(wrapper.findAll('.food-row')).toHaveLength(1)
    })
    expect(rowOf(wrapper, BOILED_EGG).text()).toContain('已停用')

    await buttonOf(rowOf(wrapper, BOILED_EGG), '恢复').trigger('click')
    await vi.waitFor(async () => {
      expect(await db.foods.get(BOILED_EGG)).toMatchObject({ disabledFlag: 0 })
    })
  })

  it('没被引用过的条目确认后真删掉', async () => {
    await seedLibrary()
    const wrapper = await mountPage()

    await buttonOf(rowOf(wrapper, CHICKEN), '删除').trigger('click')
    await vi.waitFor(async () => {
      expect(await db.foods.get(CHICKEN)).toBeUndefined()
    })
    await vi.waitFor(() => {
      expect(wrapper.text()).not.toContain(CHICKEN)
    })
  })

  it('改数值：按标签改完保存，行里是新数值，来源变成「手工」（FR-406）', async () => {
    await seedLibrary()
    const wrapper = await mountPage()

    await buttonOf(rowOf(wrapper, EGG), '改数值').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.food-editor').exists()).toBe(true)
    })

    // 六项按 NUTRIENT_KEYS 的顺序排：热量 / 蛋白 / 脂肪 / 碳水 / 纤维 / 钠，第七个是来源说明
    const inputs = wrapper.findAll('.food-editor input')
    expect((inputs[0].element as HTMLInputElement).value).toBe('144')
    await inputs[0].setValue('155')
    await inputs[1].setValue('12.6')
    await inputs[6].setValue('包装标签')
    expect(wrapper.find('.food-editor').text()).toContain('不会跟着变（DR-02）')

    await buttonOf(wrapper.find('.food-editor'), '保存数值').trigger('click')
    await vi.waitFor(async () => {
      expect(await db.foods.get(EGG)).toMatchObject({ kcal: 155, source: 'manual' })
    })
    await vi.waitFor(() => {
      const row = rowOf(wrapper, EGG)
      expect(row.text()).toContain('155 kcal')
      expect(row.text()).toContain('手工')
      expect(row.text()).toContain('包装标签 · 覆盖自内置')
    })
    expect(wrapper.find('.food-editor').exists()).toBe(false)
  })

  it('漏填一项就保存不了，并指出缺哪项（FR-406）', async () => {
    await seedLibrary()
    const wrapper = await mountPage()

    await buttonOf(rowOf(wrapper, EGG), '改数值').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.food-editor').exists()).toBe(true)
    })

    const inputs = wrapper.findAll('.food-editor input')
    await inputs[5].setValue('')
    await vi.waitFor(() => {
      expect(wrapper.find('.food-editor').text()).toContain('钠没填')
    })
    const save = buttonOf(wrapper.find('.food-editor'), '保存数值')
    expect((save.element as HTMLButtonElement).disabled).toBe(true)

    await buttonOf(wrapper.find('.food-editor'), '取消').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.food-editor').exists()).toBe(false)
    })
    expect(await db.foods.get(EGG)).toMatchObject({ kcal: 144, source: 'seed' })
  })

  it('超出合理范围只提醒不拦：写着「请确认」，保存照样能点（DR-06）', async () => {
    await seedLibrary()
    const wrapper = await mountPage()

    await buttonOf(rowOf(wrapper, EGG), '改数值').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.food-editor').exists()).toBe(true)
    })

    await wrapper.findAll('.food-editor input')[0].setValue('1200')
    await vi.waitFor(() => {
      expect(wrapper.find('.food-editor').text()).toContain('超出每 100g/ml 的合理范围')
    })
    const save = buttonOf(wrapper.find('.food-editor'), '保存数值')
    expect((save.element as HTMLButtonElement).disabled).toBe(false)
  })
})
