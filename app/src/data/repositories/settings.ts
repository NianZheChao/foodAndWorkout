import { db, SINGLETON_KEY } from '../db'
import { toPlain } from '../plain'
import { mergeReminders, REMINDER_DEFAULTS } from '@/domain/reminders'
import type { SettingsRecord } from '@/domain/types'

export function defaultSettings(): SettingsRecord {
  return {
    id: SINGLETON_KEY as 'current',
    units: { weight: 'kg', energy: 'kcal' },
    weekStart: 1,
    theme: 'auto',
    // 提醒项的定义只有一份：`domain/reminders.ts`（T4.5），免得默认值与判定逻辑各写一套
    reminders: REMINDER_DEFAULTS.map((row) => ({ ...row })),
    mutedFields: [],
    // FR-1602：三项目自报数据默认都带给模型，用户可以在「今日指导」的预览里单独关掉
    shareRecovery: { sleep: true, energy: true, soreness: true },
    updatedAt: Date.now()
  }
}

export async function getSettings(): Promise<SettingsRecord> {
  const row = await db.settings.get(SINGLETON_KEY)
  // 老数据的提醒项里没有后来新增的那几项（T4.5 的「当天摄入」）：按 id 补齐后返回。
  // 只在这次读取时补，不顺手写库 —— 用户下次在设置页改动时才落盘（避免「只读也写库」）。
  if (row) return { ...row, reminders: mergeReminders(row.reminders ?? []) }
  const fresh = defaultSettings()
  await db.settings.put(toPlain(fresh))
  return fresh
}

export async function saveSettings(patch: Partial<SettingsRecord>): Promise<SettingsRecord> {
  const current = await getSettings()
  const next: SettingsRecord = { ...current, ...patch, id: SINGLETON_KEY as 'current', updatedAt: Date.now() }
  await db.settings.put(toPlain(next))
  return next
}
