import { db } from '../db'
import { toPlain } from '../plain'
import type { PlanKind, PlanRecord } from '@/domain/types'

/**
 * 某一天某一类的推荐（`plans`，§6.2 的「当日缓存」）。
 *
 * 同一天同一类**只留一条**：推荐过期就没有参考价值，重新生成覆盖当天那一条
 * （与每日指导一致；报告那种「留历史版本」的做法在这里只会让「今天看哪一条」变得含糊）。
 */
export async function getPlan(date: string, kind: PlanKind): Promise<PlanRecord | undefined> {
  const rows = await db.plans.where('date').equals(date).toArray()
  return rows.filter((row) => row.kind === kind).sort((a, b) => b.createdAt - a.createdAt)[0]
}

/** 某一天的全部推荐（训练 + 食谱），给页面一次读完。 */
export async function listPlans(date: string): Promise<PlanRecord[]> {
  return db.plans.where('date').equals(date).toArray()
}

export async function putPlan(record: PlanRecord): Promise<void> {
  await db.plans.put(toPlain(record))
}

