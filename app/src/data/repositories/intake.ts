import { db } from '../db'
import { toPlain } from '../plain'
import type { IntakeEntry } from '@/domain/types'

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}_${rand}`
}

export async function listIntakeByDate(date: string): Promise<IntakeEntry[]> {
  const rows = await db.intake.where('date').equals(date).toArray()
  const order = { 早餐: 0, 午餐: 1, 晚餐: 2, 加餐: 3 } as const
  return rows.sort((a, b) => order[a.meal] - order[b.meal])
}

/** 区间查询（趋势页 / 报告摘要用），按日期升序。 */
export async function listIntakeInRange(start: string, end: string): Promise<IntakeEntry[]> {
  const rows = await db.intake.where('date').between(start, end, true, true).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function addIntake(entry: Omit<IntakeEntry, 'id'>): Promise<string> {
  const id = newId('in')
  await db.intake.put(toPlain({ ...entry, id }))
  return id
}

export async function updateIntake(id: string, patch: Partial<IntakeEntry>): Promise<void> {
  await db.intake.update(id, toPlain(patch))
}

export async function removeIntake(id: string): Promise<void> {
  await db.intake.delete(id)
}

/** 待补全条目数：汇总据此标注「不完整」（FR-506）。 */
export async function countPendingIntake(date: string): Promise<number> {
  return db.intake.where('date').equals(date).filter((e) => e.pendingFlag === 1).count()
}

export async function listPendingIntake(): Promise<IntakeEntry[]> {
  return db.intake.where('pendingFlag').equals(1).toArray()
}
