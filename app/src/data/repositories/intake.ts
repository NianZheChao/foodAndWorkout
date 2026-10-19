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

export async function getIntake(id: string): Promise<IntakeEntry | undefined> {
  return db.intake.get(id)
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

/**
 * 每条食物被多少条摄入记录引用过（FR-412 的删除保护），键是 `foodId`。
 *
 * 一次读全表再在内存里汇总：食物库治理页要一次拿到所有条目的引用数，
 * 按条目逐个 `count()` 会变成上百次查询。
 */
export async function tallyIntakeByFood(): Promise<Map<string, number>> {
  const rows = await db.intake.toArray()
  const tally = new Map<string, number>()
  for (const row of rows) {
    if (!row.foodId) continue
    tally.set(row.foodId, (tally.get(row.foodId) ?? 0) + 1)
  }
  return tally
}

/** 单条食物的引用数（删除前的最终判据，走索引）。 */
export async function countIntakeByFood(foodId: string): Promise<number> {
  return db.intake.where('foodId').equals(foodId).count()
}
