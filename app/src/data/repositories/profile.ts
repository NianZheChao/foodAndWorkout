import { db, SINGLETON_KEY } from '../db'
import { toPlain } from '../plain'
import type { ProfileRecord } from '@/domain/types'

export async function getProfile(): Promise<ProfileRecord | undefined> {
  return db.profile.get(SINGLETON_KEY)
}

export async function saveProfile(record: ProfileRecord): Promise<void> {
  await db.profile.put(toPlain({ ...record, id: 'current', updatedAt: Date.now() }))
}
