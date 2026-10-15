/**
 * 调用日志与用量（FR-1308 / FR-1414）。
 *
 * 只记录**估算**出来的 token 数与结果状态，绝不记录 prompt / 响应正文，
 * 避免把用户的饮食描述或 token 写进日志。本表可随时清空，也不进导出包。
 */

import { db } from '../db'
import { newId } from './intake'
import type { LlmLog } from '@/domain/types'

export interface LlmLogInput {
  taskId: string
  taskVersion: number
  model: string
  durationMs: number
  promptTokensEst: number
  completionTokensEst: number
  status: LlmLog['status']
  errorKind?: string
}

export async function logLlmCall(input: LlmLogInput, now = Date.now()): Promise<LlmLog> {
  const row: LlmLog = { id: newId('log'), createdAt: now, ...input }
  await db.llmLogs.put(row)
  return row
}

export async function listLlmLogs(limit = 50): Promise<LlmLog[]> {
  const rows = await db.llmLogs.orderBy('createdAt').reverse().limit(limit).toArray()
  return rows
}

export interface LlmUsageSummary {
  calls: number
  errors: number
  promptTokensEst: number
  completionTokensEst: number
  lastCallAt?: number
}

export async function summarizeLlmUsage(): Promise<LlmUsageSummary> {
  const rows = await db.llmLogs.toArray()
  return rows.reduce<LlmUsageSummary>(
    (sum, row) => ({
      calls: sum.calls + 1,
      errors: sum.errors + (row.status === 'error' ? 1 : 0),
      promptTokensEst: sum.promptTokensEst + row.promptTokensEst,
      completionTokensEst: sum.completionTokensEst + row.completionTokensEst,
      lastCallAt: Math.max(sum.lastCallAt ?? 0, row.createdAt) || undefined
    }),
    { calls: 0, errors: 0, promptTokensEst: 0, completionTokensEst: 0 }
  )
}

export async function clearLlmLogs(): Promise<void> {
  await db.llmLogs.clear()
}
