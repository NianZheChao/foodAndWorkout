// @vitest-environment node
/**
 * 外观 token 的两条守卫（FR-1606）。
 *
 * 1. **图表的颜色是 CSS token 的副本**：ECharts 把颜色画进 SVG，读不到 CSS 变量，
 *    所以 `app/chartTheme.ts` 里手写了两套 —— 抄错一个字符不会报错，只会在深色下变成看不清的颜色。
 *    这里逐项比对。
 * 2. **颜色只写 token**：2026-10-16 修的那批暗色缺陷（提醒卡片是浅黄底 + 浅灰字、
 *    「待核对」数字、危险按钮上的白字）全都是页面里写死的 `#fffaf3` / `#fff3cd` / `#fff`。
 *    这里静态扫一遍 `src/`，除了 `style.css` 的 token 定义与 `chartTheme.ts` 那份副本，
 *    别处一律不许再出现颜色字面量。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHART_PALETTES, type ChartPalette } from '@/app/chartTheme'

// jsdom 环境下 `import.meta.url` 不是 file: 协议，用 cwd（vitest 的工作目录就是 app/）定位源码
const SRC = join(process.cwd(), 'src')
const STYLE = join(SRC, 'style.css')
/** 唯一允许出现颜色字面量的 TS 文件：它就是那份副本，由上面的比对守住 */
const PALETTE_FILE = join(SRC, 'app', 'chartTheme.ts')

/** 摘掉注释：注释里提到旧写法（如 `#fff3cd`）不算违规。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 从 `style.css` 里取出某个选择器块内的自定义属性（这两块都没有嵌套，取到第一个行首 `}` 即可）。 */
function tokensOf(selector: string): Record<string, string> {
  const css = stripComments(readFileSync(STYLE, 'utf8'))
  const open = css.indexOf(`${selector} {`)
  expect(open, `style.css 里找不到 ${selector}`).toBeGreaterThan(-1)
  const start = css.indexOf('{', open) + 1
  const end = css.indexOf('\n}', start)
  const tokens: Record<string, string> = {}
  for (const match of css.slice(start, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim()
  }
  return tokens
}

const LIGHT = tokensOf(':root')
const DARK = tokensOf(":root[data-theme='dark']")

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (/\.(vue|css|ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/

describe('图表配色 ⇄ style.css 的 token（FR-1606）', () => {
  it('两套 token 都真的读到了', () => {
    expect(Object.keys(LIGHT).length).toBeGreaterThan(10)
    expect(Object.keys(DARK).length).toBeGreaterThan(10)
    expect(LIGHT['--brand']).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('浅色 / 深色逐项对上同名 token', () => {
    for (const [theme, tokens] of [
      ['light', LIGHT],
      ['dark', DARK]
    ] as const) {
      const palette = CHART_PALETTES[theme]
      expect(palette.series1, `${theme} series1`).toBe(tokens['--brand'])
      expect(palette.series2, `${theme} series2`).toBe(tokens['--accent'])
      expect(palette.text, `${theme} text`).toBe(tokens['--text-muted'])
      expect(palette.splitLine, `${theme} splitLine`).toBe(tokens['--border'])
      expect(palette.tooltipBg, `${theme} tooltipBg`).toBe(tokens['--surface'])
      expect(palette.tooltipBorder, `${theme} tooltipBorder`).toBe(tokens['--border'])
    }
  })

  it('两套每一项都不同：把浅色那套照抄进深色块是最容易犯的错', () => {
    for (const key of Object.keys(CHART_PALETTES.light) as (keyof ChartPalette)[]) {
      expect(CHART_PALETTES.dark[key], key).not.toBe(CHART_PALETTES.light[key])
    }
  })
})

describe('颜色只写 token（2026-10-16 暗色缺陷的守卫）', () => {
  it('页面 / 组件 / 脚本里不再出现写死的颜色', () => {
    const files = collectFiles(SRC)
    expect(files.length).toBeGreaterThan(80)

    const offenders: string[] = []
    for (const file of files) {
      if (file === PALETTE_FILE) continue
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (!COLOR_LITERAL.test(line)) return
        // 例外只有一处：style.css 里给 token 赋值的那几行（`--surface: #ffffff;`）
        const isTokenLine = file === STYLE && /^\s*--[\w-]+\s*:/.test(line)
        if (isTokenLine) return
        offenders.push(`${file.slice(SRC.length + 1)}:${index + 1} ${line.trim()}`)
      })
    }

    expect(offenders, `这些地方写死了颜色，请改用 style.css 里的 token：\n${offenders.join('\n')}`).toEqual([])
  })
})