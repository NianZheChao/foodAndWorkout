/**
 * 预算告警（§6.9 / FR-1413）：估算超过任务预算 2 倍时先问一句「还发吗」。
 *
 * 守住三件事：**只在超线时才问**、**没有确认通道时照发**（队列重放不能弹窗）、
 * **用户说「先不发」就一个请求都不发**（不花钱，原文留给用户接着改）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runTask, TASKS, type BudgetNotice, type LlmTask } from '@/llm'
import { BUDGET_WARN_RATIO, budgetOf, inputBudgetOf, outputLimitOf } from '@/llm/types'
import { db } from '@/data/db'
import { listLlmLogs } from '@/data/repositories/llmLogs'
import { chatOk, stubFetch } from './helpers/llm'
import type { ModelConfigRecord } from '@/domain/types'

/** 一条 10 个字以内的短任务：预算 100 + 900 输出，只有输入撑到 2000 才会超线。 */
const task: LlmTask<{ text: string }, { value: number }> = {
  id: 'test.budget',
  version: 1,
  title: '预算用例',
  systemPrompt: '只输出 JSON。',
  buildPayload: (input) => ({ text: input.text }),
  schema: z.object({ value: z.coerce.number() }),
  inputBudget: 900,
  maxOutputTokens: 100
}

function config(patch: Partial<ModelConfigRecord> = {}): ModelConfigRecord {
  return {
    id: 'current',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    timeoutMs: 1000,
    enabled: true,
    updatedAt: Date.now(),
    ...patch
  }
}

/** 撑出超过预算 2 倍的输入（重复同一段中文，估算按 chars 走）。 */
const LONG = '这是一段用来把输入撑过预算线的中文描述。'.repeat(200)

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('runTask 的预算告警', () => {
  it('估算没超线时不问，直接发', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{"value":1}')])
    const confirm = vi.fn(async () => false)
    const result = await runTask(task, { text: '短' }, { config: config(), deps: { fetchImpl }, confirm })

    expect(result.ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('超线时先问一句，用户同意才发；问的内容带着估算与预算', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{"value":1}')])
    const seen: BudgetNotice[] = []
    const result = await runTask(
      task,
      { text: LONG },
      {
        config: config(),
        deps: { fetchImpl },
        confirm: (notice) => {
          seen.push(notice)
          return true
        }
      }
    )

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ taskId: 'test.budget', budgetTokens: 1000 })
    expect(seen[0].ratio).toBeGreaterThan(BUDGET_WARN_RATIO)
    expect(seen[0].estimatedTokens).toBeGreaterThan(2000)
  })

  it('用户选「先不发」：一个请求都不发，也不落任何数据', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{"value":1}')])
    const result = await runTask(task, { text: LONG }, { config: config(), deps: { fetchImpl }, confirm: () => false })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.kind).toBe('cancelled')
    expect(result.ok === false && result.retriable).toBe(false)
    expect(calls).toHaveLength(0)
    // 数字要说清楚：界面照抄这句话就够用户决定「改短还是照发」
    expect(result.ok === false && result.budget?.budgetTokens).toBe(1000)
    expect(result.ok === false && result.message).toContain('先不发')
    // 没发出去的请求不进用量日志（日志只记真花了的钱）
    expect(await listLlmLogs()).toHaveLength(0)
  })

  it('没有确认通道（队列重放 / 后台）时照发：告警不拦记录链路', async () => {
    const { fetchImpl, calls } = stubFetch([chatOk('{"value":1}')])
    const result = await runTask(task, { text: LONG }, { config: config(), deps: { fetchImpl } })

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe('任务预算的声明（FR-1413）', () => {
  const cases: { id: keyof typeof TASKS; input: unknown; budget: number }[] = [
    { id: 'log.parse', input: { imageCount: 0 }, budget: 600 + 900 },
    { id: 'log.parse', input: { imageCount: 2 }, budget: 1500 + 900 },
    { id: 'food.resolve', input: { items: [{ text: '鸡蛋' }] }, budget: 400 + 200 },
    { id: 'report.weekly', input: { type: 'weekly' }, budget: 1500 + 900 },
    { id: 'report.monthly', input: { type: 'monthly' }, budget: 1500 + 1200 },
    { id: 'plan.training', input: {}, budget: 800 + 600 },
    { id: 'plan.meal', input: {}, budget: 800 + 600 },
    { id: 'coach.daily', input: {}, budget: 800 + 600 },
    { id: 'calibration.review', input: {}, budget: 800 + 500 }
  ]

  it.each(cases)('$id 的预算对得上', ({ id, input, budget }) => {
    const declared = TASKS[id] as LlmTask<unknown, unknown>
    expect(inputBudgetOf(declared, input) + outputLimitOf(declared, input)).toBe(budget)
  })

  it('月报比周报多出来的预算是输出那一头（输入上限同为 1500）', () => {
    const weekly = TASKS['report.weekly'] as LlmTask<unknown, unknown>
    const monthly = TASKS['report.monthly'] as LlmTask<unknown, unknown>
    expect(inputBudgetOf(weekly, { type: 'weekly' })).toBe(inputBudgetOf(monthly, { type: 'monthly' }))
    expect(outputLimitOf(monthly, { type: 'monthly' })).toBeGreaterThan(outputLimitOf(weekly, { type: 'weekly' }))
  })

  it('合并请求的食物解析：预算是输入 + 输出上限，输出随条目数放大', () => {
    const foods = TASKS['food.resolve'] as LlmTask<{ items: { text: string }[] }, unknown>
    const one = budgetOf(foods, { items: [{ text: 'a' }] })
    const ten = budgetOf(foods, { items: Array.from({ length: 10 }, (_, i) => ({ text: `f${i}` })) })
    expect(ten).toBeGreaterThan(one)
  })
})