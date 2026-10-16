/**
 * 诊断信息导出（T4.6 / design §10.2 / FR-1608）。
 *
 * 出问题时用户要能把「现场」发给别人，但又不能因此把体重、饮食、档案一起发出去。
 * 所以这份文件只装**排查需要、且不含健康数据与密钥**的东西：
 * 版本与 schema、运行环境、各表条数、存储占用、模型接口的**非机密配置**、
 * 调用日志汇总，以及最近 20 条错误（队列里的失败原因 + 调用日志里的错误分类）。
 *
 * 三条硬约束（由 `tests/diagnostics.spec.ts` 钉住）：
 * 1. **绝不出现 `apiKey`**，连字段名都不出现；
 * 2. 不出现任何记录内容（饮食 / 体重 / 档案都不进这个文件，只有条数）；
 * 3. 模型地址原样带上（它是排错的关键），但 token 不在里面。
 */

import { APP_VERSION } from '@/app/version'
import { todayIso } from '@/app/date'
import { db, SCHEMA_VERSION } from '@/data/db'
import { getModelConfig, isModelConfigured } from '@/data/repositories/modelConfig'
import { listLlmLogs, summarizeLlmUsage } from '@/data/repositories/llmLogs'
import { listOps } from '@/data/repositories/pendingOps'
import { EXPORT_FORMAT_VERSION } from './exportPackage'

export const DIAGNOSTICS_FORMAT_VERSION = 1
/** 只保留最近这么多条错误：再多也不会有新信息，还容易把文件撑大。 */
export const DIAGNOSTIC_ERROR_LIMIT = 20
/** 从调用日志里回捞错误的窗口。 */
export const DIAGNOSTIC_LOG_WINDOW = 200

export interface DiagnosticError {
  source: 'queue' | 'llm'
  at: number
  message: string
}

export interface DiagnosticsReport {
  formatVersion: number
  generatedAt: string
  app: { version: string; schemaVersion: number; exportFormatVersion: number }
  runtime: { userAgent: string; language: string; online: boolean; timezone: string }
  storage?: { usageBytes: number; quotaBytes: number }
  /** 每张表的条数（**只有条数**，没有内容） */
  counts: Record<string, number>
  /** 模型接口的非机密配置；`apiKey` 永远不在这里 */
  model: { configured: boolean; baseUrl: string; model: string; enabled: boolean; supportsJsonResponse?: boolean }
  llm: {
    calls: number
    errors: number
    promptTokensEst: number
    completionTokensEst: number
    lastCallAt?: number
  }
  errors: DiagnosticError[]
}

function runtimeInfo(): DiagnosticsReport['runtime'] {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  let timezone = ''
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    // 某些环境拿不到时区：留空，不影响其它信息
  }
  return {
    userAgent: nav?.userAgent ?? '',
    language: nav?.language ?? '',
    online: nav?.onLine ?? true,
    timezone
  }
}

async function storageInfo(): Promise<DiagnosticsReport['storage']> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate?.usage === undefined) return undefined
    return { usageBytes: estimate.usage, quotaBytes: estimate.quota ?? 0 }
  } catch {
    // 浏览器不支持或被拒绝：这一块直接省略
    return undefined
  }
}

export async function buildDiagnostics(now = Date.now()): Promise<DiagnosticsReport> {
  const [config, usage, ops, logs, storage] = await Promise.all([
    getModelConfig(),
    summarizeLlmUsage(),
    listOps(),
    listLlmLogs(DIAGNOSTIC_LOG_WINDOW),
    storageInfo()
  ])

  const counts: Record<string, number> = {}
  for (const table of db.tables) counts[table.name] = await table.count()

  const errors: DiagnosticError[] = []
  for (const op of ops) {
    if (op.lastError) errors.push({ source: 'queue', at: op.updatedAt, message: `${op.kind} · ${op.ref}：${op.lastError}` })
  }
  for (const log of logs) {
    if (log.status === 'error') {
      errors.push({ source: 'llm', at: log.createdAt, message: `${log.taskId}${log.errorKind ? ` · ${log.errorKind}` : ''}` })
    }
  }
  errors.sort((a, b) => b.at - a.at)

  return {
    formatVersion: DIAGNOSTICS_FORMAT_VERSION,
    generatedAt: new Date(now).toISOString(),
    app: { version: APP_VERSION, schemaVersion: SCHEMA_VERSION, exportFormatVersion: EXPORT_FORMAT_VERSION },
    runtime: runtimeInfo(),
    storage,
    counts,
    model: {
      configured: isModelConfigured(config),
      baseUrl: config?.baseUrl ?? '',
      model: config?.model ?? '',
      enabled: config?.enabled ?? false,
      supportsJsonResponse: config?.supportsJsonResponse
    },
    llm: {
      calls: usage.calls,
      errors: usage.errors,
      promptTokensEst: usage.promptTokensEst,
      completionTokensEst: usage.completionTokensEst,
      lastCallAt: usage.lastCallAt
    },
    errors: errors.slice(0, DIAGNOSTIC_ERROR_LIMIT)
  }
}

/** 缩进两格，方便用户直接贴进 issue。 */
export function serializeDiagnostics(report: DiagnosticsReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function diagnosticsFileName(date = todayIso()): string {
  return `thin-muscle-plan-diagnostics-${date}.json`
}