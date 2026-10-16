/**
 * 外观（FR-1606）：把设置里的三选一（浅色 / 深色 / 跟随系统）落到文档根节点上。
 *
 * 只做两件事：
 * 1. 把 `settings.theme` 解析成真正生效的 `light` / `dark`，写进 `<html data-theme>`；
 * 2. 给 `<html>` 加 / 去掉 `van-theme-dark` —— Vant 的深色变量挂在 `.van-theme-dark` 上，
 *    挂在根节点才能连 teleport 到 `body` 的弹窗、轻提示一起照顾到。
 *
 * **页面样式只认 `data-theme`，不认 settings**（`style.css` 里整套 token 换一遍），
 * 组件不需要知道设置存在哪儿。这里也**不缓存**当前选择：`settings` 是唯一事实来源。
 */

import { onScopeDispose, ref, type Ref } from 'vue'
import { getSettings } from '@/data/repositories/settings'
import type { SettingsRecord } from '@/domain/types'

export type ThemeChoice = SettingsRecord['theme']
export type ResolvedTheme = 'light' | 'dark'

/** 三选一 → 两档，`auto` 才看系统偏好。 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'light') return 'light'
  if (choice === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/** 系统偏好；jsdom / 老浏览器里没有 `matchMedia`，一律算浅色。 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme(choice: ThemeChoice, prefersDark = systemPrefersDark()): ResolvedTheme {
  const resolved = resolveTheme(choice, prefersDark)
  if (typeof document === 'undefined') return resolved
  const root = document.documentElement
  root.dataset.theme = resolved
  root.classList.toggle('van-theme-dark', resolved === 'dark')
  return resolved
}

/** 读设置并应用（启动时调用；设置页改完直接调 `applyTheme`，不必再读库）。 */
export async function applyThemeFromSettings(): Promise<ResolvedTheme> {
  const settings = await getSettings()
  return applyTheme(settings.theme)
}

/**
 * 当前生效的外观：读 `<html data-theme>`（**写它的人只有 `applyTheme`**，这里不缓存）。
 * 给图表这类拿不到 CSS 变量的地方用（见 `app/chartTheme.ts`）。
 */
export function currentTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** 观察 `<html data-theme>` 的变化（`applyTheme` 是唯一写入方，所以挂一个观察者就够）。返回停止函数。 */
export function watchResolvedTheme(handler: (theme: ResolvedTheme) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => undefined
  const observer = new MutationObserver(() => handler(currentTheme()))
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

/** 组件里用：跟着外观走的响应式值，卸载时自动断开观察者。 */
export function useResolvedTheme(): Ref<ResolvedTheme> {
  const theme = ref(currentTheme())
  const stop = watchResolvedTheme((next) => {
    theme.value = next
  })
  onScopeDispose(stop)
  return theme
}

/**
 * 「跟随系统」时系统配色变了要立刻跟上。返回停止函数。
 *
 * 每次都重新读设置，而不是在闭包里记一份 —— 否则用户在设置页改成「浅色」之后，
 * 这里还拿着老的 `auto` 继续跟着系统变。
 */
export function startThemeSync(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  if (typeof media.addEventListener !== 'function') return () => undefined
  const handler = (): void => {
    void getSettings().then((settings) => {
      if (settings.theme === 'auto') applyTheme('auto', media.matches)
    })
  }
  media.addEventListener('change', handler)
  return () => media.removeEventListener('change', handler)
}