// @vitest-environment node
/**
 * 快照与单日回滚（T4.3 / FR-1208，design §4.3 的「失败可回滚」）。
 *
 * 守六件事：**自动快照总在动手之前**（删条记录、导入覆盖 / 合并）、**内容没变不重复写**、
 * **回滚是整天替换**（头部 / 饮食 / 训练一起，汇总按本地口径重算）、**回滚本身可回滚**、
 * **坏快照整条拒绝**（宁可不动，也不写半份数据）、**只保留最近若干条**。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { db } from '@/data/db'
import {
  captureDay,
  listSnapshotSummaries,
  restoreDaySnapshot,
  summarizeSnapshot
} from '@/application/snapshot'
import {
  SNAPSHOT_KEEP,
  countSnapshots,
  listSnapshotsByDate,
  pruneSnapshots,
  saveSnapshot
} from '@/data/repositories/snapshots'
import { parseSnapshotPayload, SNAPSHOT_FORMAT_VERSION, type DaySnapshotPayload } from '@/io/snapshot'
import { getDay, updateDay } from '@/data/repositories/days'
import { addIntake, listIntakeByDate, removeIntake } from '@/data/repositories/intake'
import { addWorkout, listWorkoutByDate, removeWorkout } from '@/data/repositories/workout'
import { applyImport } from '@/io/importPackage'
import { buildExportPackage, checksumOf, type ExportData, type ExportPackage } from '@/io/exportPackage'
import { useDayStore } from '@/store/day'
import type { DayRecord, IntakeEntry, SnapshotRecord, WorkoutEntry } from '@/domain/types'

const DATE = '2026-10-15'
const OTHER = '2026-10-14'

function dayRow(date: string, patch: Partial<DayRecord> = {}): DayRecord {
  return { date, weekday: '四', pendingCount: 0, createdAt: 1, updatedAt: 1, ...patch }
}

function intakeRow(date: string, patch: Partial<IntakeEntry> = {}): Omit<IntakeEntry, 'id'> {
  return {
    date,
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食材',
    foodSnapshot: { name: '测试食材', unit: '100g', kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 },
    amount: { qty: 1, unit: '100g', grams: 100 },
    computed: { kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 },
    ...patch
  }
}

function workoutRow(date: string, patch: Partial<WorkoutEntry> = {}): Omit<WorkoutEntry, 'id'> {
  return {
    date,
    type: '力量',
    muscles: ['背'],
    exercise: '杠铃划船',
    sets: Array.from({ length: 4 }, () => ({ reps: 8, weightKg: 60, bodyweight: false })),
    volumeRaw: '4x8x60',
    volumeLoad: 1920,
    ...patch
  }
}

/** 读得快照里的内容；读不出来就直接炸，省得测试里到处写 `if (parsed.ok)`。 */
function payloadOf(text: string): DaySnapshotPayload {
  const parsed = parseSnapshotPayload(text)
  if (!parsed.ok) throw new Error(`快照读不出来：${parsed.error}`)
  return parsed.payload
}

function snapshot(date: string, reason: string, createdAt: number): SnapshotRecord {
  return { id: `snap_${createdAt}`, date, reason, payload: '{}', createdAt }
}

/** 拿当前库生成一个导出包，再往里塞几天（校验和跟着重算，否则会被当成"文件被改过"）。 */
async function packageWithDays(rows: DayRecord[]): Promise<ExportPackage> {
  const pkg = await buildExportPackage()
  const data: ExportData = { ...pkg.data, days: [...pkg.data.days, ...rows] }
  return { manifest: pkg.manifest, data, checksum: await checksumOf(data) }
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('自动快照', () => {
  it('内容没变就不重复写：同一天连拍两次只留一条', async () => {
    await updateDay(DATE, { weightAmKg: 75 })
    await addIntake(intakeRow(DATE))

    const first = await captureDay(DATE, '手动快照')
    expect(first.deduped).toBe(false)
    expect(first.counts).toEqual({ intake: 1, workout: 0 })

    const again = await captureDay(DATE, '删除摄入条目前的自动快照')
    expect(again.deduped).toBe(true)
    expect(again.id).toBe(first.id)
    // 去重是"没有新信息就不写"，不是"把理由改掉"：留着的还是第一条的理由
    expect(again.reason).toBe('手动快照')
    expect(await countSnapshots()).toBe(1)
    // 注意这里比较的是内容而不是两段 JSON：`takenAt` 每次都不一样（`snapshotContentKey`）
    expect(again.createdAt).toBe(first.createdAt)
  })

  it('内容变了就各留一张', async () => {
    await updateDay(DATE, { weightAmKg: 75 })
    const first = await captureDay(DATE, '手动快照')
    await updateDay(DATE, { weightAmKg: 76 })
    const second = await captureDay(DATE, '手动快照')

    expect(second.deduped).toBe(false)
    expect(second.id).not.toBe(first.id)
    expect(await countSnapshots()).toBe(2)
  })

  it('删条记录之前先拍：删掉的那条能从快照里找回来', async () => {
    setActivePinia(createPinia())
    const store = useDayStore()
    await store.load(DATE)
    const id = await store.addFoodEntry({
      meal: '午餐',
      dish: '测试餐',
      food: { name: '测试食材', unit: '100g', kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 },
      amount: { qty: 1, unit: '100g', grams: 100 },
      computed: { kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 }
    })

    await store.removeIntakeEntry(id)
    expect(await listIntakeByDate(DATE)).toHaveLength(0)
    const [row] = await listSnapshotsByDate(DATE)
    expect(row.reason).toBe('删除摄入条目前的自动快照')
    expect(payloadOf(row.payload).intake.map((entry) => entry.id)).toEqual([id])

    await restoreDaySnapshot(row.id)
    expect((await listIntakeByDate(DATE)).map((entry) => entry.id)).toEqual([id])
  })

  it('列表最新在前，并且只取 limit 条', async () => {
    await db.snapshots.bulkPut([
      snapshot(DATE, '第一张', 1),
      snapshot(DATE, '第二张', 2),
      snapshot(DATE, '第三张', 3)
    ])
    expect((await listSnapshotSummaries(2)).map((item) => item.reason)).toEqual(['第三张', '第二张'])
  })

  it('只保留最近 N 条（默认 SNAPSHOT_KEEP）', async () => {
    expect(SNAPSHOT_KEEP).toBe(100)
    await db.snapshots.bulkPut([1, 2, 3, 4, 5].map((n) => snapshot(DATE, `第 ${n} 张`, n)))

    expect(await pruneSnapshots(3)).toBe(2)
    expect(await listSnapshotsByDate(DATE)).toHaveLength(3)
    expect((await listSnapshotsByDate(DATE)).map((row) => row.reason)).toEqual(['第 5 张', '第 4 张', '第 3 张'])
    // 没超上限时什么都不删
    expect(await pruneSnapshots(10)).toBe(0)
    expect(await countSnapshots()).toBe(3)
  })
})

describe('单日回滚', () => {
  it('把头部 / 饮食 / 训练整天还原，汇总按本地口径重算', async () => {
    const intakeId = await addIntake(intakeRow(DATE))
    const workoutId = await addWorkout(workoutRow(DATE))
    await updateDay(DATE, { weightAmKg: 75, note: '原始备注' })
    const before = await captureDay(DATE, '手动快照')

    // 之后改成另一副样子：晨重变了、备注没了、原来那两条都不在
    await updateDay(DATE, { weightAmKg: 80, note: '' })
    await removeIntake(intakeId)
    await removeWorkout(workoutId)
    await addIntake(intakeRow(DATE, { dish: '后来记的一餐' }))

    const report = await restoreDaySnapshot(before.id)

    expect(report.date).toBe(DATE)
    expect(report.restored).toEqual({ day: true, intake: 1, workout: 1 })
    expect(report.replaced).toEqual({ day: true, intake: 1, workout: 0 })
    expect(report.summaryRecomputed).toBe(true)

    const day = await getDay(DATE)
    expect(day?.weightAmKg).toBe(75)
    expect(day?.note).toBe('原始备注')
    // 换掉的那条不能剩下（整天替换，不是"并集"）
    expect((await listIntakeByDate(DATE)).map((entry) => entry.dish)).toEqual(['测试餐'])
    expect((await listWorkoutByDate(DATE)).map((entry) => entry.id)).toEqual([workoutId])
    // 汇总重算过：训练容量回来了
    expect(day?.summarySnapshot?.training.volumeLoadKg).toBe(1920)
    expect(day?.summarySnapshot?.weightAmKg).toBe(75)
  })

  it('回滚前自动再拍一张，所以点错了还能滚回来', async () => {
    await updateDay(DATE, { weightAmKg: 75 })
    const before = await captureDay(DATE, '手动快照')
    await updateDay(DATE, { weightAmKg: 80 })

    const first = await restoreDaySnapshot(before.id)
    expect((await getDay(DATE))?.weightAmKg).toBe(75)

    const backup = await db.snapshots.get(first.backupId)
    if (!backup) throw new Error('回滚前那一张没有写进库')
    expect(backup.reason).toBe('回滚前自动快照')
    expect(payloadOf(backup.payload).day?.weightAmKg).toBe(80)

    await restoreDaySnapshot(backup.id)
    expect((await getDay(DATE))?.weightAmKg).toBe(80)
  })

  it('快照里没有头部却有条目：回滚后补一个头部，不让这一天从界面上消失', async () => {
    const intakeId = await addIntake(intakeRow(DATE))
    expect(await getDay(DATE)).toBeUndefined()
    const before = await captureDay(DATE, '手动快照')

    await removeIntake(intakeId)
    const report = await restoreDaySnapshot(before.id)

    expect(report.restored).toEqual({ day: false, intake: 1, workout: 0 })
    expect(await getDay(DATE)).toBeDefined()
    expect(await listIntakeByDate(DATE)).toHaveLength(1)
  })

  it('快照读不出来时整条拒绝，一个字节都不改', async () => {
    await updateDay(DATE, { weightAmKg: 75 })
    await addIntake(intakeRow(DATE))
    const broken = await saveSnapshot({ date: DATE, reason: '手工塞的坏快照', payload: '{不是 json' })

    const summary = summarizeSnapshot(broken)
    expect(summary.broken).toBe(true)
    expect(summary.counts).toEqual({ intake: 0, workout: 0 })

    await expect(restoreDaySnapshot(broken.id)).rejects.toThrow(/未做任何改动/)
    expect((await getDay(DATE))?.weightAmKg).toBe(75)
    expect(await listIntakeByDate(DATE)).toHaveLength(1)
    // 拒绝得早：连"回滚前的备份"都没拍（否则坏快照会挤掉真的安全网）
    expect(await listSnapshotsByDate(DATE)).toHaveLength(1)
  })

  it('格式版本比本应用新 → 拒绝并提示升级', async () => {
    const future = await saveSnapshot({
      date: DATE,
      reason: '来自未来的快照',
      payload: JSON.stringify({ formatVersion: SNAPSHOT_FORMAT_VERSION + 1, scope: 'day', date: DATE, intake: [], workout: [] })
    })
    await expect(restoreDaySnapshot(future.id)).rejects.toThrow(/升级应用/)
  })

  it('快照已经不存在（被上限清掉了）→ 说清楚', async () => {
    await expect(restoreDaySnapshot('snap_不存在')).rejects.toThrow(/不存在/)
  })
})

describe('导入前的自动快照', () => {
  it('合并前按冲突日各拍一张，快照里是导入前的样子', async () => {
    await updateDay(DATE, { weightAmKg: 74 })
    const report = await applyImport(await packageWithDays([dayRow(DATE, { weightAmKg: 80 })]), { strategy: 'merge' })

    expect(report.snapshots).toBe(1)
    const rows = await listSnapshotsByDate(DATE)
    expect(rows.map((row) => row.reason)).toEqual(['导入合并前自动快照'])
    expect(payloadOf(rows[0].payload).day?.weightAmKg).toBe(74)
  })

  it('覆盖前只给真正会被覆盖的日期拍（没勾的按跳过处理，不拍）', async () => {
    await updateDay(DATE, { weightAmKg: 74 })
    await updateDay(OTHER, { weightAmKg: 76 })
    const pkg = await packageWithDays([dayRow(DATE, { weightAmKg: 80 }), dayRow(OTHER, { weightAmKg: 90 })])

    const report = await applyImport(pkg, { strategy: 'overwrite', overwriteDates: [OTHER] })

    expect(report.snapshots).toBe(1)
    expect((await listSnapshotsByDate(OTHER)).map((row) => row.reason)).toEqual(['导入覆盖前自动快照'])
    expect(await listSnapshotsByDate(DATE)).toEqual([])
  })

  it('跳过策略本机一条都不动，也就不拍', async () => {
    await updateDay(DATE, { weightAmKg: 74 })
    const report = await applyImport(await packageWithDays([dayRow(DATE, { weightAmKg: 80 })]), { strategy: 'skip' })

    expect(report.snapshots).toBe(0)
    expect(await countSnapshots()).toBe(0)
  })
})
