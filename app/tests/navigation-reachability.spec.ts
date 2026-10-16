// @vitest-environment jsdom
/**
 * 导航树的完整性守卫：「先声明树、再渲染」这把锁。
 *
 * 这个文件是从一次真实事故里长出来的（2026-10-15）：重排今日页时删掉了旧的「还没有的内容」卡片，
 * 顺手把「模型设置」的**唯一入口**一起删了 —— 页面还在、路由还在、测试也全过，因为当时的用例
 * 只断言了「应该是哪六个入口」，把遗漏写成了期望值。
 *
 * 那次之后靠「静态扫描有没有写死的入口」兜着；2026-10-16 重构又把入口收进了导航树
 * （`app/src/app/nav.ts`，页头 `AppHeader.vue` 按它渲染本域导航条，底部 tab 也由它派生），
 * 于是这里的守卫换成三条更硬的：
 *
 * 1. **路由表 ⇄ 导航树一一对应**：新增页面忘了登记，界面上只是「没有同级入口」这种看不出来的小毛病，
 *    这里直接失败；
 * 2. **每条路由只归一个域**：归错或重叠会让 tab 高亮打架、甚至出现「一个都不亮」；
 * 3. **写死的站内跳转都指向存在的路由**：改路径时漏改一处，这里失败。
 *
 * **能力边界**：它只能发现「登记漏了 / 路径写错了」。入口藏在条件分支里（例如只在队列非空时
 * 才渲染的按钮）它看不出来 —— 那种情况靠 DOM 层的断言，见 `pages.spec.ts` 里
 * 「模型设置在任何状态都能进」那条。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { navDomains, navTabs, navLocation } from '@/app/nav'
import type { RouteRecordRaw } from 'vue-router'
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

/**
 * 把路由表里的一条路径展开成它能落到的具体路径。
 * 本项目只用到这几种写法：`/summary/:date?`（可选参数，去掉）、
 * `/log/:kind(diet|workout|body)`（枚举，展开成三条）、`/reports/:id`（必填参数，原样保留）。
 */
function expandRoute(path: string): string[] {
  const alternation = path.match(/^(.*)\/:[^/]*\(([^)]+)\)(\?)?$/)
  if (alternation) {
    const base = alternation[1]
    const values = alternation[2].split('|').map((value) => `${base}/${value}`)
    // 带 `?` 的枚举自己还有一条 base 路径（如 `/log`），不带 `?` 的只展开成枚举值
    return alternation[3] ? [base, ...values] : values
  }
  return [path.replace(/\/:[^/]*\?$/, '')]
}

/**
 * 只做跳转、没有页面组件的记录（现在的 `/` 与 `/log`）不进比对：
 * 它们不渲染任何东西，也就没有「同级入口」这回事。
 */
function isPageRoute(route: RouteRecordRaw): boolean {
  return 'component' in route || !('redirect' in route)
}

const routePaths = routes.filter(isPageRoute).flatMap((route) => expandRoute(route.path))
const navPaths = navDomains.flatMap((domain) => [domain.root, ...domain.pages.map((page) => page.path)])

/** 页面里写死的站内跳转目标（`push('/x')` / `to="/x"`；模板字符串取静态前缀）。 */
function collectJumpLiterals(): Set<string> {
  const found = new Set<string>()
  for (const file of collectFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:push|replace)\(\s*[`'"](\/[^`'"]*)/g)) found.add(match[1])
    for (const match of text.matchAll(/\bto="(\/[^"]*)"/g)) found.add(match[1])
    for (const match of text.matchAll(/\bto='(\/[^']*)'/g)) found.add(match[1])
  }
  return found
}

/** 这个写死的目标是不是真的路由（含 `/reports/${id}` 这种只写了前缀的）。 */
function isKnownPath(target: string): boolean {
  const clean = target.length > 1 ? target.replace(/\/+$/, '') : target
  if (clean === '/') return true
  return routePaths.some((path) => {
    if (clean === path || path.startsWith(`${clean}/`)) return true
    return new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`).test(clean)
  })
}

const jumps = collectJumpLiterals()

describe('导航树完整性（路由表 ⇄ 树）', () => {
  it('扫描确实读到了路由、导航树与源码', () => {
    expect(routePaths.length).toBeGreaterThan(15)
    expect(navPaths.length).toBeGreaterThan(15)
    expect(jumps.size).toBeGreaterThan(5)
  })

  it('路由表的每一条都在导航树里登记了（漏登记 = 页面上没有同级入口）', () => {
    const registered = new Set(navPaths)
    const missing = routePaths.filter((path) => !registered.has(path))
    expect(missing, `这些路由没登记进 app/src/app/nav.ts：${missing.join(' / ')}`).toEqual([])
  })

  it('导航树里也没有多余 / 写错的路径', () => {
    const known = new Set(routePaths)
    const extra = navPaths.filter((path) => !known.has(path))
    expect(extra, `导航树里这些路径没有对应路由：${extra.join(' / ')}`).toEqual([])
  })

  it('每条路由只归一个域（否则 tab 高亮会打架）', () => {
    for (const path of routePaths) {
      const owners = navDomains.filter((domain) =>
        domain.match.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
      )
      expect(owners.map((domain) => domain.key), path).toHaveLength(1)
    }
  })

  it('域内页面都被自己域的高亮前缀覆盖（不会有页面一个 tab 都不亮）', () => {
    for (const domain of navDomains) {
      for (const path of [domain.root, ...domain.pages.map((page) => page.path)]) {
        expect(navLocation(path).domain?.key, `${path} 不在任何域里`).toBe(domain.key)
      }
    }
  })

  it('导航条里含域根与全部子页：没有 hidden 的页面都会出现在每一页的导航条上', () => {
    for (const domain of navDomains) {
      const visible = domain.pages.filter((page) => !page.hidden).map((page) => page.path)
      // 域内任意一个可见页面看到的导航条都是同一套
      for (const path of [domain.root, ...visible]) {
        expect(navLocation(path).chips.map((chip) => chip.path)).toEqual([domain.root, ...visible])
      }
    }
  })

  it('page 里写死的站内跳转都指向存在的路由', () => {
    const broken = [...jumps].filter((target) => !isKnownPath(target))
    expect(broken, `这些跳转指向不存在的路由：${broken.join(' / ')}`).toEqual([])
  })
})

describe('底部 tab 与「模型设置」的常驻可达（2026-10-15 事故的守卫）', () => {
  it('底部恰好五个域，每个域都有根页与图标', () => {
    expect(navTabs).toHaveLength(5)
    expect(navTabs.map((tab) => tab.to)).toEqual(['/today', '/log/diet', '/trend', '/me', '/settings'])
    for (const tab of navTabs) expect(tab.icon).not.toBe('')
  })

  it('模型设置挂在「设置」域里：tab 常驻可达，且每个设置页都能一步跳到', () => {
    const here = navLocation('/settings/model')
    expect(here.domain?.root).toBe('/settings')
    expect(navTabs.map((tab) => tab.to)).toContain('/settings')
    expect(here.chips.map((chip) => chip.path)).toContain('/settings/model')
  })
})