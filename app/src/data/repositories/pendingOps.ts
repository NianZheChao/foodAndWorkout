import { db } from '../db'
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
  await db.pendingOps.put(op)
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
  await db.pendingOps.update(id, { ...patch, updatedAt: Date.now() })
}