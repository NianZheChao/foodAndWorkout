/**
 * 模型配置（FR-1300）。
 *
 * 只支持 OpenAI 兼容的 Chat Completions，地址与 token 一律由用户自己填，应用不预置、
 * 不代为申请。token 只存这里：不写日志、不进导出包、不在错误提示里回显（FR-1305 / NFR-11）。
 */

import { db, SINGLETON_KEY } from '../db'
import { toPlain } from '../plain'
import type { ModelConfigRecord } from '@/domain/types'

export function defaultModelConfig(): ModelConfigRecord {
  return {
    id: SINGLETON_KEY as 'current',
    baseUrl: '',
    apiKey: '',
    model: '',
    timeoutMs: 60_000,
    enabled: true,
    updatedAt: Date.now()
  }
}

export async function getModelConfig(): Promise<ModelConfigRecord> {
  const row = await db.modelConfig.get(SINGLETON_KEY)
  if (row) return row
  const fresh = defaultModelConfig()
  await db.modelConfig.put(toPlain(fresh))
  return fresh
}

export async function saveModelConfig(patch: Partial<ModelConfigRecord>): Promise<ModelConfigRecord> {
  const current = await getModelConfig()
  const next: ModelConfigRecord = { ...current, ...patch, id: SINGLETON_KEY as 'current', updatedAt: Date.now() }
  await db.modelConfig.put(toPlain(next))
  return next
}

/** 清空 token 与地址（保留超时等偏好）。 */
export async function clearModelCredentials(): Promise<ModelConfigRecord> {
  return saveModelConfig({ baseUrl: '', apiKey: '', model: '', lastTestAt: undefined, lastTestOk: undefined, lastTestMessage: undefined })
}

/**
 * 是否可用。三项齐全且未被显式关闭才算配好——缺任何一项都不发请求，
 * 这样「没配模型」永远只表现为降级，而不是一次注定失败的调用。
 */
export function isModelConfigured(config: ModelConfigRecord | undefined): boolean {
  if (!config) return false
  return config.enabled && config.baseUrl.trim() !== '' && config.apiKey.trim() !== '' && config.model.trim() !== ''
}
