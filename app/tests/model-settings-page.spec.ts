// @vitest-environment jsdom
/**
 * 模型设置页（FR-1300 / FR-1305）。
 *
 * 用户要自己填地址与 token，所以这里守着两件事：保存时地址被归一化且 token 原样留本机；
 * 探测连通性顺手把「支不支持 response_format」记进配置，后续请求不用再撞一次 400。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ModelSettingsPage from '@/pages/ModelSettingsPage.vue'
import { routes } from '@/router'
import { db } from '@/data/db'
import { getModelConfig } from '@/data/repositories/modelConfig'
import { chatOk, fakeResponse, stubFetch } from './helpers/llm'

async function mountPage() {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/settings/model')
  await router.isReady()
  const wrapper = mount(ModelSettingsPage, { global: { plugins: [createPinia(), router] } })
  await flushPromises()
  return wrapper
}

function button(wrapper: Awaited<ReturnType<typeof mountPage>>, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text() === label)
  if (!found) throw new Error(`找不到按钮「${label}」`)
  return found
}

async function fill(wrapper: Awaited<ReturnType<typeof mountPage>>, values: string[]): Promise<void> {
  const inputs = wrapper.findAll('input')
  for (const [index, value] of values.entries()) await inputs[index].setValue(value)
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('模型设置页', () => {
  it('保存时归一化地址，token 原样留在本机', async () => {
    const wrapper = await mountPage()
    await fill(wrapper, ['https://api.example.com/v1/chat/completions/', 'sk-secret', 'gpt-4o-mini', '90'])
    await button(wrapper, '保存').trigger('click')
    await vi.waitFor(async () => {
      expect((await getModelConfig()).baseUrl).toBe('https://api.example.com/v1')
    })
    await flushPromises()

    const saved = await getModelConfig()
    expect(saved.apiKey).toBe('sk-secret')
    expect(saved.model).toBe('gpt-4o-mini')
    expect(saved.timeoutMs).toBe(90_000)
    // 最终请求地址直接显示出来，省得用户猜
    expect(wrapper.text()).toContain('https://api.example.com/v1/chat/completions')
  })

  it('探测连通性成功时写入上次测试结果与 JSON 模式结论', async () => {
    const { fetchImpl } = stubFetch([chatOk('{"ok":true}')])
    vi.stubGlobal('fetch', fetchImpl)

    const wrapper = await mountPage()
    await fill(wrapper, ['https://api.example.com/v1', 'sk-secret', 'gpt-4o-mini', '30'])
    await button(wrapper, '测试连通性').trigger('click')
    await vi.waitFor(async () => {
      expect((await getModelConfig()).lastTestOk).toBe(true)
    })
    await flushPromises()

    const saved = await getModelConfig()
    expect(saved.supportsJsonResponse).toBe(true)
    expect(saved.lastTestMessage).toContain('连接正常')
  })

  it('接口不支持 response_format 时自动降级并记住结论', async () => {
    const { fetchImpl, calls } = stubFetch([
      fakeResponse({ error: { message: 'response_format is not supported' } }, 400),
      chatOk('{"ok":true}')
    ])
    vi.stubGlobal('fetch', fetchImpl)

    const wrapper = await mountPage()
    await fill(wrapper, ['https://api.example.com/v1', 'sk-secret', 'gpt-4o-mini', '30'])
    await button(wrapper, '测试连通性').trigger('click')
    await vi.waitFor(async () => {
      expect((await getModelConfig()).lastTestOk).toBe(true)
    })
    await flushPromises()

    const saved = await getModelConfig()
    expect(saved.supportsJsonResponse).toBe(false)
    expect('response_format' in calls[0].body).toBe(true)
    expect('response_format' in calls[1].body).toBe(false)
  })
})
