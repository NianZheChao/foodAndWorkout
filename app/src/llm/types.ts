import type { ZodType } from 'zod'

/**
 * 一个模型任务的声明（§6.2）。
 *
 * 契约的核心是「输入本地构造 + 输出 Zod 校验」：`buildPayload` 只放白名单字段，
 * 禁止把 `days` / `intake` 原始对象直接序列化（DR-40）。
 */
export interface LlmTask<In, Out> {
  id: string
  version: number
  title: string
  /** 固定且短（≤200 字）：只讲输出契约，不讲过程（§6.9） */
  systemPrompt: string
  buildPayload(input: In): unknown
  schema: ZodType<Out>
  /** 输入预算（FR-1413 的目标值）；批量任务可按输入规模缩放 */
  inputBudget: number | ((input: In) => number)
  /** 输出上限；可按输入规模放大（如按条目数） */
  maxOutputTokens: number | ((input: In) => number)
}

export function inputBudgetOf<In, Out>(task: LlmTask<In, Out>, input: In): number {
  return typeof task.inputBudget === 'function' ? task.inputBudget(input) : task.inputBudget
}

export function outputLimitOf<In, Out>(task: LlmTask<In, Out>, input: In): number {
  return typeof task.maxOutputTokens === 'function' ? task.maxOutputTokens(input) : task.maxOutputTokens
}

/**
 * 单次请求的「任务预算」= 输入预算 + 输出上限（§6.9）。
 *
 * 它是**告警线**，不是硬限制：请求真要超了，问用户一句就好，绝不替用户做决定。
 */
export function budgetOf<In, Out>(task: LlmTask<In, Out>, input: In): number {
  return inputBudgetOf(task, input) + outputLimitOf(task, input)
}

/** 估算超过任务预算几倍就先问一句（设计文档 §6.9「预算告警」）。 */
export const BUDGET_WARN_RATIO = 2