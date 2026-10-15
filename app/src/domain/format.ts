/**
 * 数值格式化。与 `scripts/nutrition.py` 的 `fmt` / `fmt_signed` 对齐：
 * 整数不带小数点，非整数保留 1 位小数且去掉末尾 0，缺失一律显示 `-`。
 *
 * 只在显示与导出时使用；存储与计算永远保留原始浮点（避免口径漂移）。
 */

export function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  if (Math.abs(value - Math.round(value)) > 1e-9) {
    return value.toFixed(1).replace(/\.0$/, '')
  }
  return String(Math.round(value))
}

export function fmtSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return (value > 0 ? '+' : '') + fmtNumber(value)
}

/** 百分比显示：`%.0f%%`（如 23%）。 */
export function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}%`
}

