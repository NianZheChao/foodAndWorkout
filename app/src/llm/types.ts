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
  /** 输出上限；可按输入规模放大（如按条目数） */
  maxOutputTokens: number | ((input: In) => number)
}

export function outputLimitOf<In, Out>(task: LlmTask<In, Out>, input: In): number {
  return typeof task.maxOutputTokens === 'function' ? task.maxOutputTokens(input) : task.maxOutputTokens
}
