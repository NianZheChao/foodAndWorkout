import { db } from '../db'
import { toPlain } from '../plain'
import type { AdviceRecord } from '@/domain/types'

/** 某一天的指导；同一天最多留一条（重新生成覆盖当日那一条，见 `application/coach.ts`）。 */
export async function getAdviceByDate(date: string): Promise<AdviceRecord | undefined> {
  const rows = await db.adviceLog.where('date').equals(date).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)[0]
}

export async function getAdvice(id: string): Promise<AdviceRecord | undefined> {
  return db.adviceLog.get(id)
}

/** 最近若干天的指导，倒序（新的在前）；给 `history.advice` 与页面列表用。 */
export async function listRecentAdvice(limit = 10): Promise<AdviceRecord[]> {
  const rows = await db.adviceLog.orderBy('date').reverse().toArray()
  return rows.slice(0, limit)
}

export async function putAdvice(record: AdviceRecord): Promise<void> {
  await db.adviceLog.put(toPlain(record))
}
