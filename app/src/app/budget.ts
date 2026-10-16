/**
 * 预算告警的界面出口（§6.9 / FR-1413）。
 *
 * `llm/` 只负责算出「估算 / 预算」并把结论交给 `confirm`，**弹窗这种事留给界面**：
 * 换一个界面（CLI、桌面壳）照样能接。这里就是浏览器里那一份实现。
 *
 * 约定：用户点「先不发」→ 返回 `false`，`runTask` 据此中止请求并返回 `kind: 'cancelled'`，
 * **不消耗任何 token**；用户关掉弹窗（点遮罩 / 返回）同样按「先不发」算。
 */

import { showConfirmDialog } from 'vant'
import type { BudgetNotice, RunOptions } from '@/llm'

export type BudgetConfirm = NonNullable<RunOptions['confirm']>

function fmtTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

export const confirmOverBudget: BudgetConfirm = async (notice: BudgetNotice): Promise<boolean> => {
  try {
    await showConfirmDialog({
      title: '这次请求比较大',
      message:
        `估算约 ${fmtTokens(notice.estimatedTokens)} tokens（输入加输出上限），是「${notice.taskId}」` +
        `任务预算 ${fmtTokens(notice.budgetTokens)} 的 ${notice.ratio.toFixed(1)} 倍。` +
        '仍然发送吗？',
      confirmButtonText: '仍然发送',
      cancelButtonText: '先不发'
    })
    return true
  } catch {
    return false
  }
}