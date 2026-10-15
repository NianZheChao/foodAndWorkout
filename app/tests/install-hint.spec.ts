// @vitest-environment jsdom
/**
 * 「添加到主屏幕」引导（T0.2 / FR-1501 / FR-1510）。
 *
 * 三个分支各自成立：已经装好了就不再打扰；iOS 只能给「分享 → 添加到主屏」的说明；
 * Chromium 有原生安装事件时才给按钮。关掉之后要记住，不再出现。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import InstallHint from '@/components/InstallHint.vue'

const STORAGE_KEY = 'thinMusclePlan.installHintDismissed'

function stubEnvironment(options: { userAgent: string; standalone?: boolean }): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: options.userAgent,
    configurable: true
  })
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({ matches: !!options.standalone && query.includes('standalone') }),
    configurable: true
  })
}

function mountHint(): VueWrapper {
  return mount(InstallHint)
}

function installEvent(): Event {
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
  }
  event.prompt = vi.fn(async () => undefined)
  event.userChoice = Promise.resolve({ outcome: 'accepted' })
  return event
}

beforeEach(() => {
  localStorage.clear()
  stubEnvironment({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' })
})

describe('安装引导', () => {
  it('已经装到主屏（standalone）就不再提示', () => {
    stubEnvironment({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120', standalone: true })
    const wrapper = mountHint()
    expect(wrapper.text()).toBe('')
  })

  it('iOS 给出「分享 → 添加到主屏」的说明，且不给安装按钮（FR-1510）', async () => {
    stubEnvironment({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' })
    const wrapper = mountHint()
    await flushPromises()
    expect(wrapper.text()).toContain('分享')
    expect(wrapper.text()).toContain('添加到主屏')
    expect(wrapper.findAll('button').map((item) => item.text())).toEqual(['知道了'])
  })

  it('没有安装事件时给浏览器菜单的操作指引', async () => {
    const wrapper = mountHint()
    await flushPromises()
    expect(wrapper.text()).toContain('安装应用 / 添加到主屏')
  })

  it('抓得到 beforeinstallprompt 时给「安装」按钮，点了调原生弹窗（FR-1501）', async () => {
    const wrapper = mountHint()
    await flushPromises()
    expect(wrapper.text()).not.toContain('装到主屏后可以离线打开，记一笔不用先找浏览器。')

    const event = installEvent()
    window.dispatchEvent(event)
    await flushPromises()
    expect(wrapper.text()).toContain('装到主屏后可以离线打开')

    const installButton = wrapper.findAll('button').find((item) => item.text() === '安装')
    if (!installButton) throw new Error('找不到「安装」按钮')
    await installButton.trigger('click')
    await flushPromises()
    expect((event as unknown as { prompt: () => void }).prompt).toHaveBeenCalled()
    // 用户接受安装后就收起来
    expect(wrapper.text()).toBe('')
  })

  it('点「知道了」后记住选择，重新挂载也不再提示', async () => {
    const wrapper = mountHint()
    await flushPromises()
    const dismiss = wrapper.findAll('button').find((item) => item.text() === '知道了')
    if (!dismiss) throw new Error('找不到「知道了」按钮')
    await dismiss.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toBe('')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1')

    expect(mountHint().text()).toBe('')
  })
})
