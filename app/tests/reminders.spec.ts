// @vitest-environment jsdom
/**
 * 提醒（T4.5 / M11 FR-1101 / FR-1104 / FR-1105，design §9.4 的 TD-09）。
 *
 * 守四件事：**到点才催**（不是一整天催）、**同一件事一天只催一次**、
 * **收尾那天才提周报 / 月报**（还跟着 `weekStart` 走）、
 * **没授权 / 不支持时静默跳过，应用内提醒照旧**。
 *
 * 判定全在 `domain/reminders.ts` 的纯函数里，事实由 `application/reminders.ts` 查库凑出；
 * 系统通知那一条链路在 `application/notify.ts`，这里用假的 `Notification` 覆盖各权限状态。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/data/db'
import { META_KEYS, setMeta } from '@/data/meta'
import { updateDay } from '@/data/repositories/days'
import { addIntake } from '@/data/repositories/intake'
import { putReport } from '@/data/repositories/reports'
import { saveSettings } from '@/data/repositories/settings'
import {
  notificationSupport,
  notifiedToday,
  requestNotificationPermission,
  runReminderTick,
  startReminderLoop
} from '@/application/notify'
import { buildReminderState } from '@/application/reminders'
import { periodOf } from '@/domain/reportDigest'
import {
  REMINDER_DEFAULTS,
  REMINDER_IDS,
  dueReminders,
  factsFor,
  mergeReminders,
  minutesOfTime,
  pendingReminders,
  reminderHint,
  reminderOpen,
  reminderTarget,
  type ReminderFactInput,
  type ReminderFacts
} from '@/domain/reminders'
import type { IntakeEntry, ReminderSetting, ReportRecord, ReportType } from '@/domain/types'

const DEFAULT_FACTS: ReminderFactInput = {
  weekStart: 1,
  hasMorningWeight: false,
  hasEveningWeight: false,
  hasIntake: false,
  hasWeeklyReport: false,
  hasMonthlyReport: false
}

/** 2026-03-07 是周六、2026-03-08 是周日（周一起算时这一周的最后一天）、2026-03-31 是月末。 */
function factsAt(date: string, clock: string, patch: Partial<ReminderFactInput> = {}): ReminderFacts {
  const [hour, minute] = clock.split(':').map(Number)
  const [year, month, day] = date.split('-').map(Number)
  return factsFor(date, new Date(year, month - 1, day, hour, minute), { ...DEFAULT_FACTS, ...patch })
}

/** 只开某项（其余关掉），把「到点才响」与「一天只响一次」从别的提醒里隔出来。 */
function remindersOnly(id: string, time?: string): ReminderSetting[] {
  return REMINDER_DEFAULTS.map((row) => ({
    ...row,
    enabled: row.id === id,
    time: row.id === id && time ? time : row.time
  }))
}

function intakeRow(date: string): Omit<IntakeEntry, 'id'> {
  return {
    date,
    meal: '午餐',
    dish: '测试餐',
    foodId: '测试食材',
    foodSnapshot: {
      name: '测试食材',
      unit: '100g',
      kcal: 120,
      proteinG: 20,
      fatG: 3,
      carbG: 5,
      fiberG: 1,
      sodiumMg: 60
    },
    amount: { qty: 1, unit: '100g', grams: 100 },
    computed: { kcal: 120, proteinG: 20, fatG: 3, carbG: 5, fiberG: 1, sodiumMg: 60 }
  }
}

function reportRow(type: ReportType, anchor: string): ReportRecord {
  const period = periodOf(type, anchor)
  return {
    id: `rep_${type}_${period.start}`,
    type,
    label: period.label,
    periodStart: period.start,
    periodEnd: period.end,
    // 提醒判定只看 `type` 与 `periodStart`，摘要内容在这里无关紧要
    digest: {} as ReportRecord['digest'],
    content: null,
    status: 'draft',
    editedByUser: false,
    createdAt: 1,
    updatedAt: 1
  }
}

interface FiredNotification {
  title: string
  body?: string
}

let fired: FiredNotification[] = []

function clearNotification(): void {
  ;(globalThis as { Notification?: unknown }).Notification = undefined
}

/** 直接把「某项今天已经通知过」写进 meta，省去为了造这个状态真弹一次通知。 */
async function setNotified(id: string, date: string): Promise<void> {
  await setMeta(META_KEYS.reminderNotified, { [id]: date })
}

/** 装一台假的 `Notification`；`'unsupported'` 表示这台设备根本没有这个 API（iOS 未装到主屏）。 */
function stubNotification(permission: 'default' | 'granted' | 'denied' | 'unsupported'): FiredNotification[] {
  fired = []
  if (permission === 'unsupported') {
    clearNotification()
    return fired
  }
  class FakeNotification {
    static permission = permission
    static requestPermission = vi.fn(async () => permission)
    constructor(title: string, options?: { body?: string }) {
      fired.push({ title, body: options?.body })
    }
  }
  ;(globalThis as { Notification?: unknown }).Notification = FakeNotification
  return fired
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
  clearNotification()
})

describe('提醒判定（纯函数）', () => {
  it('时间字符串解析成分钟数；解析不出来的永远不到点', () => {
    expect(minutesOfTime('22:30')).toBe(1350)
    expect(minutesOfTime('09:00')).toBe(540)
    expect(minutesOfTime(' 7:05 ')).toBe(425)
    expect(minutesOfTime('24:00')).toBeNaN()
    expect(minutesOfTime('9:0')).toBeNaN()
    expect(minutesOfTime('')).toBeNaN()
  })

  it('应用内提醒只问「今天还没完成」的项，用户关掉的不问', () => {
    const saturday = factsAt('2026-03-07', '08:00')
    expect(pendingReminders(REMINDER_DEFAULTS, saturday).map((row) => row.id)).toEqual([
      REMINDER_IDS.morningWeight,
      REMINDER_IDS.eveningWeight,
      REMINDER_IDS.intake
    ])

    const intakeOff = REMINDER_DEFAULTS.map((row) =>
      row.id === REMINDER_IDS.intake ? { ...row, enabled: false } : row
    )
    expect(pendingReminders(intakeOff, saturday).map((row) => row.id)).toEqual([
      REMINDER_IDS.morningWeight,
      REMINDER_IDS.eveningWeight
    ])
  })

  it('本地通知要过了设定时间才响：08:59 不响、09:00 响', () => {
    expect(dueReminders(REMINDER_DEFAULTS, factsAt('2026-03-07', '08:59'))).toEqual([])
    expect(dueReminders(REMINDER_DEFAULTS, factsAt('2026-03-07', '09:00')).map((row) => row.id)).toEqual([
      REMINDER_IDS.morningWeight
    ])
    expect(dueReminders(REMINDER_DEFAULTS, factsAt('2026-03-07', '22:45')).map((row) => row.id)).toEqual([
      REMINDER_IDS.morningWeight,
      REMINDER_IDS.eveningWeight,
      REMINDER_IDS.intake
    ])
  })

  it('周报只在这一周的最后一天提，而且「哪一天算最后一天」跟着 weekStart 走', () => {
    expect(factsAt('2026-03-08', '20:00').isWeekEnd).toBe(true)
    expect(factsAt('2026-03-07', '20:00').isWeekEnd).toBe(false)
    expect(factsAt('2026-03-07', '20:00', { weekStart: 7 }).isWeekEnd).toBe(true)

    const sunday = factsAt('2026-03-08', '20:00')
    expect(pendingReminders(REMINDER_DEFAULTS, sunday).map((row) => row.id)).toContain(REMINDER_IDS.weeklyReport)
    expect(
      pendingReminders(REMINDER_DEFAULTS, { ...sunday, hasWeeklyReport: true }).map((row) => row.id)
    ).not.toContain(REMINDER_IDS.weeklyReport)

    const saturday = factsAt('2026-03-07', '20:00', { weekStart: 7 })
    expect(pendingReminders(REMINDER_DEFAULTS, saturday).map((row) => row.id)).toContain(REMINDER_IDS.weeklyReport)
  })

  it('月报只在本月最后一天提（2 月 28 日也算月末）', () => {
    expect(factsAt('2026-03-30', '20:00').isMonthEnd).toBe(false)
    expect(factsAt('2026-03-31', '20:00').isMonthEnd).toBe(true)
    expect(factsAt('2026-02-28', '20:00').isMonthEnd).toBe(true)
    expect(pendingReminders(REMINDER_DEFAULTS, factsAt('2026-02-28', '20:00')).map((row) => row.id)).toContain(
      REMINDER_IDS.monthlyReport
    )
  })

  it('认不出的 id 不臆造语义：不算未完成，但仍有提示与去处', () => {
    const custom: ReminderSetting = { id: 'custom-x', label: '自己加的', time: '12:00', enabled: true }
    expect(reminderOpen(custom, factsAt('2026-03-07', '23:00'))).toBe(false)
    expect(reminderHint('custom-x')).toBe('打开应用补上这一项。')
    expect(reminderTarget('custom-x')).toBe('/today')
    expect(reminderTarget(REMINDER_IDS.morningWeight)).toBe('/log/body')
    expect(reminderHint(REMINDER_IDS.intake)).toContain('一餐')
  })

  it('按 id 补齐默认项：用户改过的时间保留，缺的项补回来，多出来的留在后面', () => {
    const stored: ReminderSetting[] = [
      { id: REMINDER_IDS.morningWeight, label: '晨起称重', time: '07:30', enabled: false },
      { id: 'custom-x', label: '自己加的', time: '12:00', enabled: true }
    ]
    const merged = mergeReminders(stored)
    expect(merged.map((row) => row.id)).toEqual([...REMINDER_DEFAULTS.map((row) => row.id), 'custom-x'])
    expect(merged[0]).toEqual({ id: REMINDER_IDS.morningWeight, label: '晨起称重', time: '07:30', enabled: false })
    expect(merged.find((row) => row.id === REMINDER_IDS.intake)).toEqual(
      REMINDER_DEFAULTS.find((row) => row.id === REMINDER_IDS.intake)
    )
    // 不返回同一批对象：页面改开关不该动到 REMINDER_DEFAULTS
    expect(merged[0]).not.toBe(stored[0])
    expect(merged[0]).not.toBe(REMINDER_DEFAULTS[0])
  })
})

describe('应用层：事实从库里凑', () => {
  it('今天称过重、记过一餐、生成过周报，就都不再提醒', async () => {
    const date = '2026-03-08'
    await updateDay(date, { weightAmKg: 70, weightPmKg: 71 })
    await addIntake(intakeRow(date))
    await putReport(reportRow('weekly', date))

    const state = await buildReminderState(date, new Date(2026, 2, 8, 21, 0))
    expect(state.pending).toEqual([])
    expect(state.due).toEqual([])
    expect(state.all).toHaveLength(REMINDER_DEFAULTS.length)
  })

  it('上一周的报告不算数：本周没有周报就照样提醒', async () => {
    const date = '2026-03-08'
    await putReport(reportRow('weekly', '2026-03-01'))
    const state = await buildReminderState(date, new Date(2026, 2, 8, 21, 0))
    expect(state.pending.map((row) => row.id)).toContain(REMINDER_IDS.weeklyReport)
  })

  it('用户在设置里关掉的项，应用内与通知两条链路都不再出现', async () => {
    await saveSettings({ reminders: REMINDER_DEFAULTS.map((row) => ({ ...row, enabled: false })) })
    const state = await buildReminderState('2026-03-08', new Date(2026, 2, 8, 23, 0))
    expect(state.pending).toEqual([])
    expect(state.due).toEqual([])
    expect(state.all.every((row) => !row.enabled)).toBe(true)
  })

  it('改过时间的项按新时间判定（22:59 不响、23:00 才响）', async () => {
    await saveSettings({ reminders: remindersOnly(REMINDER_IDS.morningWeight, '23:00') })
    expect((await buildReminderState('2026-03-08', new Date(2026, 2, 8, 22, 59))).due).toEqual([])
    expect(
      (await buildReminderState('2026-03-08', new Date(2026, 2, 8, 23, 0))).due.map((row) => row.id)
    ).toEqual([REMINDER_IDS.morningWeight])
  })
})

describe('本地通知（能力探测 + 一天一次）', () => {
  it('设备没有 Notification 就是不支持；有就看权限怎么说', () => {
    expect(notificationSupport()).toBe('unsupported')
    stubNotification('default')
    expect(notificationSupport()).toBe('default')
    stubNotification('denied')
    expect(notificationSupport()).toBe('denied')
    stubNotification('granted')
    expect(notificationSupport()).toBe('granted')
  })

  it('申请权限：不支持时不抛错，直接说「不支持」', async () => {
    expect(await requestNotificationPermission()).toBe('unsupported')
    stubNotification('granted')
    expect(await requestNotificationPermission()).toBe('granted')
  })

  it('没授权就一条都不弹，但应用内提醒照旧（FR-1104）', async () => {
    await saveSettings({ reminders: remindersOnly(REMINDER_IDS.intake) })
    stubNotification('default')

    const tick = await runReminderTick('2026-03-07', new Date(2026, 2, 7, 21, 0))
    expect(tick.support).toBe('default')
    expect(tick.notified).toEqual([])
    expect(fired).toEqual([])

    const state = await buildReminderState('2026-03-07', new Date(2026, 2, 7, 21, 0))
    expect(state.pending.map((row) => row.id)).toEqual([REMINDER_IDS.intake])
  })

  it('同一件事一天只弹一次（FR-1105）：第二次 tick 不再弹', async () => {
    const date = '2026-03-31'
    await saveSettings({ reminders: remindersOnly(REMINDER_IDS.monthlyReport) })
    stubNotification('granted')

    const first = await runReminderTick(date, new Date(2026, 2, 31, 21, 0))
    expect(first.notified).toEqual([REMINDER_IDS.monthlyReport])
    expect(fired).toHaveLength(1)
    expect(fired[0].title).toContain('月报')
    expect(await notifiedToday(REMINDER_IDS.monthlyReport, date)).toBe(true)

    const second = await runReminderTick(date, new Date(2026, 2, 31, 21, 1))
    expect(second.notified).toEqual([])
    expect(fired).toHaveLength(1)

    // 「今天通知过」是按天记的：到了另一个月，还能再响
    expect(await notifiedToday(REMINDER_IDS.monthlyReport, '2026-04-30')).toBe(false)
  })

  it('到点的项只弹没弹过的那些', async () => {
    await saveSettings({ reminders: remindersOnly(REMINDER_IDS.intake, '00:00') })
    stubNotification('granted')
    await setNotified(REMINDER_IDS.intake, '2026-03-07')
    const tick = await runReminderTick('2026-03-07', new Date(2026, 2, 7, 9, 0))
    expect(tick.notified).toEqual([])
    expect(fired).toEqual([])
  })

  it('startReminderLoop 立刻检查一次，停掉之后不再动（切回前台也不重复）', async () => {
    // 用「当天摄入」+ 00:00：与日历无关，任何时候都到点
    await saveSettings({ reminders: remindersOnly(REMINDER_IDS.intake, '00:00') })
    stubNotification('granted')

    const stop = startReminderLoop(60_000)
    await vi.waitFor(() => expect(fired).toHaveLength(1))

    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(fired).toHaveLength(1)

    stop()
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(fired).toHaveLength(1)
  })
})
