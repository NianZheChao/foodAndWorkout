// @vitest-environment jsdom
/**
 * 预算告警的界面出口（`app/budget.ts`）：把「估算 / 预算」说成人话，
 * 并严格区分「仍然发送」与「先不发」（关掉弹窗同样算不发）。
 */

import { describe, expect, it, vi } from 'vitest'
import { showConfirmDialog } from 'vant'
import { confirmOverBudget } from '@/app/budget'
import type { BudgetNotice } from '@/llm'

// jsdom 里没人点弹窗，`showConfirmDialog` 的 promise 不会自己 resolve。
// 只替掉这一个函数，`llm/` 与其它 Vant 组件照旧。
vi.mock('vant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vant')>()
  return { ...actual, showConfirmDialog: vi.fn(async () => 'confirm') }
})

const NOTICE: BudgetNotice = { taskId: 'plan.training', estimatedTokens: 3200, budgetTokens: 1400, ratio: 2.3 }

describe('confirmOverBudget', () => {
  it('点「仍然发送」返回 true，并把估算与预算写进弹窗文案', async () => {
    expect(await confirmOverBudget(NOTICE)).toBe(true)
    const options = vi.mocked(showConfirmDialog).mock.calls[0][0]
    expect(options.message).toContain('3.2k')
    expect(options.message).toContain('1.4k')
    expect(options.message).toContain('plan.training')
    expect(options.confirmButtonText).toBe('仍然发送')
    expect(options.cancelButtonText).toBe('先不发')
  })

  it('点「先不发」或直接关掉弹窗都返回 false（不花 token 是默认那一侧）', async () => {
    vi.mocked(showConfirmDialog).mockRejectedValueOnce(new Error('cancel'))
    expect(await confirmOverBudget(NOTICE)).toBe(false)
  })

  it('不到 1000 的估算照原样说，不写成 0.4k', async () => {
    await confirmOverBudget({ ...NOTICE, estimatedTokens: 820, budgetTokens: 400, ratio: 2.1 })
    expect(vi.mocked(showConfirmDialog).mock.calls.at(-1)?.[0].message).toContain('820 tokens')
  })
})