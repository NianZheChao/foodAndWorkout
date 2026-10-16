/**
 * 本地通知（T4.5 / FR-1101 / FR-1104 / FR-1105）。
 *
 * 只有「应用打开着」这一种触发时机 —— 没有后端就没有真推送（TD-09）：
 * **不做 Web Push、不做 Service Worker 定时唤醒、不做 .ics 导出**。浏览器支持且用户授权时，
 * 应用在前台（或重新回到前台）就按设定时间弹一条；不支持 / 未授权则静默跳过，
 * 完全不影响应用内提醒与其他功能（FR-1104）。
 *
 * 两处刻意的设计：
 * 1. 权限状态每次实时读 `Notification.permission`（不缓存），用户去浏览器设置里改回来能立刻生效；
 * 2. 「同一事项一天内不重复催」（FR-1105）记在 `meta` 里（本机状态，不进导出包）。
 */

import { getMeta, META_KEYS, setMeta } from '@/data/meta'
import { todayIso } from '@/app/date'
import { reminderHint } from '@/domain/reminders'
import { buildReminderState } from './reminders'
import type { ReminderSetting } from '@/domain/types'

export type NotificationSupport = 'unsupported' | 'default' | 'granted' | 'denied'

export function notificationSupport(): NotificationSupport {
  if (typeof Notification === 'undefined') return 'unsupported'
  const permission = Notification.permission
  if (permission === 'granted' || permission === 'denied') return permission
  return 'default'
}

/**
 * 申请通知权限。iOS 上必须先把应用「添加到主屏幕」再打开，否则 `Notification` 根本不存在 ——
 * 这时返回 `unsupported`，界面照实说明（FR-1510 平台差异透明）。
 */
export async function requestNotificationPermission(): Promise<NotificationSupport> {
  if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') {
    return 'unsupported'
  }
  try {
    return (await Notification.requestPermission()) as NotificationSupport
  } catch {
    return notificationSupport()
  }
}

type NotifiedMap = Record<string, string>

async function notifiedMap(): Promise<NotifiedMap> {
  return (await getMeta<NotifiedMap>(META_KEYS.reminderNotified)) ?? {}
}

/** 这一项今天已经通知过了吗（FR-1105）。 */
export async function notifiedToday(id: string, date: string): Promise<boolean> {
  return (await notifiedMap())[id] === date
}

async function markNotified(id: string, date: string): Promise<void> {
  const map = await notifiedMap()
  map[id] = date
  await setMeta(META_KEYS.reminderNotified, map)
}

function fire(reminder: ReminderSetting): void {
  const body = `${reminderHint(reminder.id)}（设定时间 ${reminder.time}）`
  try {
    new Notification(`薄肌计划 · ${reminder.label}`, { body, tag: `thin-muscle-${reminder.id}` })
  } catch {
    // 通知失败不能影响应用（FR-1104）；下一分钟还会再试
  }
}

export interface ReminderTickResult {
  support: NotificationSupport
  /** 这一次真的弹出来的提醒 id */
  notified: string[]
}

/**
 * 检查一次到点的提醒并弹通知。应用打开时每分钟跑一次（`startReminderLoop`），
 * 也可在测试里直接调用。
 */
export async function runReminderTick(
  date: string = todayIso(),
  now: Date = new Date()
): Promise<ReminderTickResult> {
  const support = notificationSupport()
  const state = await buildReminderState(date, now)
  if (support !== 'granted' || !state.due.length) return { support, notified: [] }

  const notified: string[] = []
  for (const reminder of state.due) {
    if (await notifiedToday(reminder.id, date)) continue
    fire(reminder)
    await markNotified(reminder.id, date)
    notified.push(reminder.id)
  }
  return { support, notified }
}

/**
 * 应用打开期间每分钟检查一次，并在从后台切回前台时补一次
 * （移动端后台会冻结定时器，只靠 interval 会漏掉到点的那一分钟）。
 */
export function startReminderLoop(intervalMs = 60_000): () => void {
  let stopped = false
  const tick = (): void => {
    if (stopped) return
    void runReminderTick().catch(() => undefined)
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') tick()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    stopped = true
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
