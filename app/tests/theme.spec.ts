// @vitest-environment jsdom
/**
 * 外观（T4.6 / FR-1606）：三选一 → 文档根节点上的 `data-theme` + Vant 的 `van-theme-dark`。
 *
 * 守五件事：**「跟随系统」真的跟着系统变**、**手动选了浅色 / 深色就不再跟**、
 * **改完立刻生效（写库只保证下次打开是对的）**、**没有 `matchMedia` 的环境不炸**、
 * **拿不到 CSS 变量的地方（图表）能跟着 `data-theme` 变**。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import {
  applyTheme,
  applyThemeFromSettings,
  currentTheme,
  resolveTheme,
  startThemeSync,
  systemPrefersDark,
  useResolvedTheme,
  watchResolvedTheme
} from '@/app/theme'
import { db } from '@/data/db'
import { getSettings, saveSettings } from '@/data/repositories/settings'

interface SchemeStub {
  flip: (prefersDark: boolean) => void
}

function stubScheme(prefersDark: boolean): SchemeStub {
  const listeners = new Set<() => void>()
  const media = {
    matches: prefersDark,
    addEventListener: (_type: string, handler: () => void) => listeners.add(handler),
    removeEventListener: (_type: string, handler: () => void) => listeners.delete(handler)
  }
  Object.defineProperty(window, 'matchMedia', {
    value: () => media,
    configurable: true,
    writable: true
  })
  return {
    flip: (dark: boolean) => {
      media.matches = dark
      for (const handler of listeners) handler()
    }
  }
}

function clearScheme(): void {
  // jsdom 本身不实现 matchMedia：显式清掉，避免用例之间互相影响
  Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true, writable: true })
}

/** 让 `startThemeSync` 里那条 `getSettings().then(...)` 跑完。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  clearScheme()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.classList.remove('van-theme-dark')
})

describe('外观', () => {
  it('三档解析：light / dark 直接定，auto 看系统偏好', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('auto', true)).toBe('dark')
    expect(resolveTheme('auto', false)).toBe('light')
  })

  it('没有 matchMedia 就算浅色（老浏览器 / jsdom 也不能炸）', () => {
    expect(systemPrefersDark()).toBe(false)
    expect(applyTheme('auto')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('写到 <html data-theme> 上，并给 Vant 加 / 去掉 van-theme-dark', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    // Vant 的深色变量挂在 .van-theme-dark 上，得挂在根节点才能照顾 teleport 出去的弹窗
    expect(document.documentElement.classList.contains('van-theme-dark')).toBe(true)

    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.classList.contains('van-theme-dark')).toBe(false)
  })

  it('跟随系统：系统切换深色立刻跟上；手动选了浅色就不再跟', async () => {
    const scheme = stubScheme(false)
    await saveSettings({ theme: 'auto' })
    applyTheme('auto', false)

    const stop = startThemeSync()
    scheme.flip(true)
    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark')
    })

    // 用户在设置页改成「浅色」之后，系统怎么变都不该动它
    await saveSettings({ theme: 'light' })
    applyTheme('light')
    scheme.flip(false)
    scheme.flip(true)
    await tick()
    expect(document.documentElement.dataset.theme).toBe('light')

    // 停下来之后也不该再响应
    await saveSettings({ theme: 'auto' })
    applyTheme('auto', false)
    stop()
    scheme.flip(true)
    await tick()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('当前外观读 <html data-theme>；变色时观察者拿到新值，停了就不再收', async () => {
    expect(currentTheme()).toBe('light')

    const seen: string[] = []
    const stop = watchResolvedTheme((next) => seen.push(next))

    applyTheme('dark')
    expect(currentTheme()).toBe('dark')
    await vi.waitFor(() => {
      expect(seen).toEqual(['dark'])
    })

    stop()
    applyTheme('light')
    await tick()
    expect(seen).toEqual(['dark'])
  })

  it('组件里用 useResolvedTheme：值跟着外观走，作用域销毁后自动断开', async () => {
    applyTheme('light')
    const scope = effectScope()
    const theme = scope.run(() => useResolvedTheme())
    if (!theme) throw new Error('effectScope 里没拿到 ref')
    expect(theme.value).toBe('light')

    applyTheme('dark')
    await vi.waitFor(() => {
      expect(theme.value).toBe('dark')
    })

    applyTheme('light')
    await tick()
    scope.stop()
    applyTheme('dark')
    await tick()
    // 观察者已断开：作用域销毁之后系统里再怎么变都不该动这个值
    expect(theme.value).toBe('light')
  })

  it('启动时按库里的设置应用一次', async () => {
    await saveSettings({ theme: 'dark' })
    expect(await applyThemeFromSettings()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')

    await saveSettings({ theme: 'light' })
    expect(await applyThemeFromSettings()).toBe('light')
    expect((await getSettings()).theme).toBe('light')
  })
})
