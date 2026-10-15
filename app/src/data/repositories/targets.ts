import { db, SINGLETON_KEY } from '../db'
import { toPlain } from '../plain'
import type { CalibrationRecord, TargetsRecord } from '@/domain/types'

export async function getTargets(): Promise<TargetsRecord | undefined> {
  return db.targets.get(SINGLETON_KEY)
}

/** 首次引导时写入目标（FR-902/FR-804）；已存在则整体覆盖。 */
export async function putTargets(record: Omit<TargetsRecord, 'id' | 'updatedAt'>): Promise<TargetsRecord> {
  const next: TargetsRecord = { ...record, id: 'current', updatedAt: Date.now() }
  await db.targets.put(toPlain(next))
  return next
}

/** 局部更新目标；只允许复盘 / 校准流程调用（FR-903）。 */
export async function saveTargets(patch: Partial<TargetsRecord>): Promise<TargetsRecord> {
  const current = await getTargets()
  if (!current) throw new Error('尚未初始化目标值，请先运行首次引导')
  const next: TargetsRecord = { ...current, ...patch, id: 'current', updatedAt: Date.now() }
  await db.targets.put(toPlain(next))
  return next
}

/** 校准必须留痕：改目标的同时写入一行校准记录（DR-32 / FR-903）。 */
export async function applyCalibration(input: {
  date: string
  measuredTdee: number
  kcalAfter: number
  basis: string
}): Promise<void> {
  const current = await getTargets()
  if (!current) throw new Error('尚未初始化目标值')
  const record: CalibrationRecord = {
    id: `cal_${input.date}_${Date.now().toString(36)}`,
    date: input.date,
    measuredTdee: input.measuredTdee,
    kcalBefore: current.kcalTarget,
    kcalAfter: input.kcalAfter,
    basis: input.basis,
    createdAt: Date.now()
  }
  await db.transaction('rw', db.targets, db.calibrations, async () => {
    await db.calibrations.put(toPlain(record))
    await db.targets.put(
      toPlain({ ...current, kcalTarget: input.kcalAfter, lastCalibrated: input.date, updatedAt: Date.now() })
    )
  })
}

export async function listCalibrations(): Promise<CalibrationRecord[]> {
  const rows = await db.calibrations.toArray()
  // 同一天可能有多行（例如首次估算后立刻又校准一次），用 createdAt 兜底，保证最新的一行在前
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
}
