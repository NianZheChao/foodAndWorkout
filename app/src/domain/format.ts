/**
 * 数值格式化。与 `scripts/nutrition.py` 的 `fmt` / `fmt_signed` 对齐：
 * 整数不带小数点，非整数保留 1 位小数且去掉末尾 0，缺失一律显示 `-`。
 *
 * 只在显示与导出时使用；存储与计算永远保留原始浮点（避免口径漂移）。
 */

/**
 * 保留 1 位小数，**逢半取偶**，与 Python 的 `'%.1f'` 一致。
 *
 * 不能用 `toFixed`：`(7.25).toFixed(1)` 给 `"7.3"`，Python 给 `"7.2"`，而 0.25 的倍数
 * 正是**均值**最常撞上的数字（如 4 条记录的 RPE 平均 29/4）。两边差一位小数，
 * 「导出的 AUTO 区块与脚本逐字一致」这条验收就会随机失败（2026-10-16 撞上）。
 *
 * 做法：把 double 展开成 20 位小数的精确十进制，再按十进制做逢半取偶 —— 直接算
 * `value * 10` 会先把误差引进乘法里（0.05 会因此变成 0.0，而 Python 给 0.1）。
 */
export function fmtNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  const exact = Math.abs(value).toFixed(20)
  // |value| ≥ 1e21 时 toFixed 会退回指数写法，那种量级不该出现在记录里，按整数兜底
  if (exact.includes('e')) return String(Math.round(value))
  const dot = exact.indexOf('.')
  const head = exact.slice(dot + 1, dot + 2)
  const rest = exact.slice(dot + 2)
  const half = `5${'0'.repeat(rest.length - 1)}`
  let tenths = Number(exact.slice(0, dot)) * 10 + Number(head)
  if (rest > half || (rest === half && tenths % 2 === 1)) tenths += 1
  const sign = value < 0 ? '-' : ''
  return tenths % 10 === 0 ? `${sign}${tenths / 10}` : `${sign}${Math.floor(tenths / 10)}.${tenths % 10}`
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
