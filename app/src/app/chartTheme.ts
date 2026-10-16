/**
 * 图表配色（`TrendPage` 的三张图）。
 *
 * ECharts 把颜色直接画进 SVG，**读不到 CSS 变量**，所以只能在这里按外观给两套。
 * 其中 `series1` / `series2` / `text` / `splitLine` / `tooltipBg` / `tooltipBorder`
 * 逐项对应 `style.css` 的同名 token（`--brand` / `--accent` / `--text-muted` / `--border` /
 * `--surface`），由 `tests/theme-tokens.spec.ts` 比对 —— 改了一处忘另一处会直接失败。
 *
 * `series3`（蛋白）是唯一的例外：图表专用的第三色，没有对应 token。
 * 浅色下用 #2563eb，深色下提亮到 #7aa2f7，免得深蓝在近黑底上糊成一片。
 *
 * 提示框那两项也必须给：ECharts 的 tooltip 默认写死白底（`tokens.color.neutral00`），
 * 深色下点一下图就闪一块白。
 */

import type { ResolvedTheme } from './theme'

export interface ChartPalette {
  /** 主色：晨重散点 / 热量柱 / 容量负荷柱（= `--brand`） */
  series1: string
  /** 强调色：7 日均线 / 目标虚线 / 组数（= `--accent`） */
  series2: string
  /** 第二量纲：蛋白曲线（图表专用，无 token） */
  series3: string
  /** 轴与图例的文字（= `--text-muted`） */
  text: string
  /** 轴线与分割线（= `--border`） */
  splitLine: string
  /** 提示框底（= `--surface`） */
  tooltipBg: string
  /** 提示框描边（= `--border`） */
  tooltipBorder: string
}

export const CHART_PALETTES: Record<ResolvedTheme, ChartPalette> = {
  light: {
    series1: '#2f7d5b',
    series2: '#b45309',
    series3: '#2563eb',
    text: '#6b7280',
    splitLine: '#e6e8ea',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e6e8ea'
  },
  dark: {
    series1: '#57b892',
    series2: '#d9a05b',
    series3: '#7aa2f7',
    text: '#9aa4ae',
    splitLine: '#2c333a',
    tooltipBg: '#1b2026',
    tooltipBorder: '#2c333a'
  }
}

export function chartPalette(theme: ResolvedTheme): ChartPalette {
  return CHART_PALETTES[theme]
}