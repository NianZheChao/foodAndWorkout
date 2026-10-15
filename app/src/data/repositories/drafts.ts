/**
 * 草稿仓储（§6.12）。
 *
 * 澄清没答完的条目以**草稿**存在，可以当天稍后接着答；草稿不参与当日汇总（DR-48 / FR-113）。
 * 图片本身永不落库（FR-1417），这里只留张数。
 */

import { db } from '../db'
import { toPlain } from '../plain'
import type { DraftRecord } from '@/domain/types'

export async function putDraft(draft: DraftRecord): Promise<void> {
  await db.drafts.put(toPlain(draft))
}

export async function getDraft(id: string): Promise<DraftRecord | undefined> {
  return db.drafts.get(id)
}

export async function listOpenDrafts(date?: string): Promise<DraftRecord[]> {
  const rows = date
    ? await db.drafts.where('date').equals(date).toArray()
    : await db.drafts.toArray()
  return rows
    .filter((draft) => draft.status === 'collecting' || draft.status === 'ready')
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function countOpenDrafts(): Promise<number> {
  return (await listOpenDrafts()).length
}

export async function deleteDraft(id: string): Promise<void> {
  await db.drafts.delete(id)
}
