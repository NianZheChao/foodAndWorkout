// @vitest-environment jsdom
/**
 * 关于与免责声明（T4.6 / FR-1608 / 需求 §9）。
 *
 * 需求把七条安全提示写成「产品内必须存在」，所以这里**逐条**断言原文都在 ——
 * 少了哪一条、或者被人「润色」成摘要，这条用例当场失败。
 */

import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import AboutPage from '@/pages/AboutPage.vue'
import { routes } from '@/router'
import { APP_VERSION } from '@/app/version'
import { SCHEMA_VERSION } from '@/data/db'

/** 需求 §9 的七条原文。 */
const DISCLAIMERS = [
  '本产品提供的是基于公开营养学与训练学常识的记录工具与建议，不构成医疗建议。',
  '有基础疾病、进食障碍、孕期或伤痛的，先咨询医生或注册营养师。',
  '体重变化建议控制在每周 0.5%~1% 体重以内，不长期执行极端低热量饮食。',
  '热量长期明显低于目标时，主动提示肌肉流失与 TDEE 下降风险。',
  '出现持续疲劳、睡眠障碍、月经异常、关节疼痛、肿热麻木、尿色变深等情况，提示就医，不继续加量。',
  '模型生成的营养数据属于估算，包装标签或用户实测值优先；不要把估算值当成精确数据。',
  '模型由用户自行配置，其可用性、准确性与费用由用户与其服务提供方决定。'
]

async function mountAbout(): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/about')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(AboutPage, { global: { plugins: [pinia, router] } })
  return { wrapper, router }
}

describe('关于与免责声明', () => {
  it('需求 §9 的七条原文都在页面上', async () => {
    const { wrapper } = await mountAbout()
    const text = wrapper.text()
    for (const line of DISCLAIMERS) expect(text).toContain(line)
    expect(wrapper.findAll('.hint-list li').length).toBeGreaterThanOrEqual(DISCLAIMERS.length)
  })

  it('说清数据存在哪、怎么搬走、什么时候必须先导出（FR-1201 / FR-1207 / FR-1210）', async () => {
    const { wrapper } = await mountAbout()
    const text = wrapper.text()
    expect(text).toContain('IndexedDB')
    expect(text).toContain('没有后端')
    expect(text).toContain('卸载或清除站点数据之前先导出')
    expect(text).toContain('模型 token 只存本机')
  })

  it('给出应用版本与数据库 schema，并且能直接从「数据」页导出', async () => {
    const { wrapper, router } = await mountAbout()
    expect(wrapper.text()).toContain(APP_VERSION)
    expect(wrapper.text()).toContain(`v${SCHEMA_VERSION}`)

    const entry = wrapper.findAll('button').find((item) => item.text().includes('数据'))
    if (!entry) throw new Error('找不到去「数据」页的入口')
    await entry.trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe('/data')
    })
  })

  it('二级页面带返回按钮（底部 tab 只有五个入口，其他页面必须自带退路）', async () => {
    const { wrapper } = await mountAbout()
    expect(wrapper.find('.back-btn').exists()).toBe(true)
  })
})
