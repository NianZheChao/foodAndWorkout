import { db, SINGLETON_KEY } from '../db'
import { toPlain } from '../plain'
import type { SettingsRecord } from '@/domain/types'

export function defaultSettings(): SettingsRecord {
  return {
    id: SINGLETON_KEY as 'current',
    units: { weight: 'kg', energy: 'kcal' },
    weekStart: 1,
    theme: 'auto',
    reminders: [
      { id: 'morning-weight', label: '晨起称重', time: '09:00', enabled: true },
      { id: 'evening-weight', label: '睡前称重', time: '22:30', enabled: true },
      { id: 'weekly-report', label: '周末生成周报', time: '20:00', enabled: true },
      { id: 'monthly-report', label: '月初生成月报', time: '20:00', enabled: true }
    ],
    mutedFields: [],
    updatedAt: Date.now()
  }
}

export async function getSettings(): Promise<SettingsRecord> {
  const row = await db.settings.get(SINGLETON_KEY)
  if (row) return row
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
