// @vitest-environment jsdom
/**
 * 「页面不能是孤岛」：路由表里每个页面都必须有**至少一处**写死的入口。
 *
 * 这是从一次真实事故里长出来的用例（2026-10-15）：重排今日页时删掉了旧的「还没有的内容」卡片，
 * 顺手把「模型设置」的唯一入口一起删了 —— 页面还在、路由还在、测试也全过，
 * 因为当时的用例只断言了「应该是哪六个入口」，把遗漏写成了期望值。
 *
 * 做法是静态扫描：把所有页面 / App.vue / 组件里出现的 `push('/xxx')`、`to="/xxx"` 字面量
 * 收集起来，再逐条比对路由表。带参数的路由（`/reports/:id`）按静态前缀匹配。
 *
 * **能力边界**：它只能发现「一个引用都没有」的页面。入口藏在条件分支里（例如只在队列非空时
 * 才渲染的按钮）它看不出来 —— 那种情况要靠 DOM 层的断言，见 `pages.spec.ts` 里
 * 「模型设置在任何状态下都能进」那两条用例。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routes } from '@/router'

// jsdom 环境下 `import.meta.url` 不是 file: 协议，用 cwd（vitest 的工作目录就是 app/）定位源码
const SRC = join(process.cwd(), 'src')

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (/\.(vue|ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 所有写死在源码里的站内跳转目标（含模板字符串的开头，如 `/reports/${id}`）。 */
function collectLinkLiterals(): Set<string> {
  const found = new Set<string>()
  for (const file of collectFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/['"`](\/[a-zA-Z0-9/_-]*)/g)) found.add(match[1])
  }
  return found
}

const literals = collectLinkLiterals()

/** 路由表里的静态路径（去掉参数段与重定向根路径）。 */
const staticPaths = routes
  .map((route) => route.path)
  .filter((path) => path !== '/' && !path.startsWith(':'))
  .map((path) => path.replace(/\/:.*$/, '').replace(/\(.*\)\??$/, ''))

describe('导航可达性（静态扫描）', () => {
  it('路由表非空，且扫描确实读到了源码', () => {
    expect(staticPaths.length).toBeGreaterThan(8)
    expect(literals.size).toBeGreaterThan(5)
  })

  it.each(staticPaths)('%s 至少有一处写死的入口', (path) => {
    expect(literals.has(path), `没有任何页面 / 组件链接到 ${path}`).toBe(true)
  })

  it('模型设置（/settings/model）在两处可达：今日页「更多」与设置页占位', () => {
    const today = readFileSync(join(SRC, 'pages', 'TodayPage.vue'), 'utf8')
    const placeholder = readFileSync(join(SRC, 'pages', 'PlaceholderPage.vue'), 'utf8')
    expect(today).toContain("'/settings/model'")
    expect(placeholder).toContain("'/settings/model'")
  })
})
