import { db } from '../db'
import { toPlain } from '../plain'
import { newId } from './intake'
import type { PendingOp } from '@/domain/types'

export async function enqueue(kind: PendingOp['kind'], ref: string): Promise<string> {
  const now = Date.now()
  const op: PendingOp = {
    id: newId('op'),
    kind,
    ref,
    status: 'queued',
    attempts: 0,
    createdAt: now,
    updatedAt: now
  }
  await db.pendingOps.put(toPlain(op))
  return op.id
}

export async function listOpenOps(): Promise<PendingOp[]> {
  const rows = await db.pendingOps.toArray()
  return rows
    .filter((op) => op.status !== 'done')
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function countOpenOps(): Promise<number> {
  const rows = await listOpenOps()
  return rows.length
}

export async function markOp(id: string, patch: Partial<PendingOp>): Promise<void> {
  await db.pendingOps.update(id, toPlain({ ...patch, updatedAt: Date.now() }))
}

/** 全部队列项（含已完成的），新的在前 —— 数据页要给人看队列的全貌，不只是还剩几条。 */
export async function listOps(): Promise<PendingOp[]> {
  const rows = await db.pendingOps.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 把一条从队列里拿掉（数据页的「不再提醒」）。
 * 只删这条例队项，**不碰任何记录** —— 那条记录仍是「待补全」，只是没人再自动重试它。
 */
export async function removeOp(id: string): Promise<void> {
  await db.pendingOps.delete(id)
}
