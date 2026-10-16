import { db, SINGLETON_KEY } from './db'
import { toPlain } from './plain'

export const META_KEYS = {
  schemaVersion: 'schemaVersion',
  seededAt: 'foodsSeededAt',
  seedVersion: 'foodsSeedVersion',
  lastBackupAt: 'lastBackupAt',
  lastSyncAt: 'lastSyncAt',
  /** T4.5：「今天已经通知过哪些提醒」按天记录，用来满足 FR-1105（同一事项一天内不重复催） */
  reminderNotified: 'reminderNotified'
} as const

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key)
  return row?.value as T | undefined
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put(toPlain({ key, value, updatedAt: Date.now() }))
}

export { SINGLETON_KEY }
