<script setup lang="ts">
/**
 * 设置（T4.5 先落「提醒」，其余属 T4.6）。
 *
 * 这个页面在 T4.5 里承担一件硬需求：**把提醒的限制写在用户能看见的地方**（FR-1101 / TD-09）。
 * 本应用没有后端，所以做不了真推送 —— 用户很容易以为「设了时间就一定会响」，
 * 必须当面说清：应用关着的时候不会响，也没有日历 / .ics 导出。
 *
 * 改一下就存一下（没有「保存」按钮）：这个页面每一项都是一个明确动作，
 * 多一个提交按钮只会让用户担心「我改的存了没有」。
 */

import { computed, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import { getSettings, saveSettings } from '@/data/repositories/settings'
import {
  notificationSupport,
  requestNotificationPermission,
  type NotificationSupport
} from '@/application/notify'
import { applyTheme, type ThemeChoice } from '@/app/theme'
import { mergeReminders, reminderHint } from '@/domain/reminders'
import type { ReminderSetting } from '@/domain/types'

const SUPPORT_TEXT: Record<NotificationSupport, string> = {
  unsupported: '这台设备 / 浏览器不支持系统通知：只会有应用内提醒。',
  default: '还没有授权：点下面的按钮申请。iOS 上要先把应用「添加到主屏幕」再打开，否则没有通知可用。',
  granted: '已授权：应用打开着的时候，到了设定时间会弹一条通知。',
  denied: '已被拒绝：需要到浏览器的站点设置里改回来，或只用应用内提醒。'
}

const reminders = ref<ReminderSetting[]>([])
const weekStart = ref<1 | 7>(1)
const theme = ref<ThemeChoice>('auto')
const mutedFields = ref<string[]>([])
const support = ref<NotificationSupport>('unsupported')
const loaded = ref(false)

const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

const themeLabel = computed(
  () => THEME_CHOICES.find((item) => item.value === theme.value)?.label ?? '跟随系统'
)

const supportText = computed(() => SUPPORT_TEXT[support.value])
const permissionButton = computed(() => {
  if (support.value === 'granted') return '已授权系统通知'
  if (support.value === 'denied') return '已被拒绝（去浏览器设置里改）'
  if (support.value === 'unsupported') return '本设备不支持系统通知'
  return '开启系统通知'
})

async function load(): Promise<void> {
  const settings = await getSettings()
  reminders.value = mergeReminders(settings.reminders ?? [])
  weekStart.value = settings.weekStart
  theme.value = settings.theme
  mutedFields.value = [...(settings.mutedFields ?? [])]
  support.value = notificationSupport()
  loaded.value = true
}

onMounted(load)

async function persist(): Promise<void> {
  await saveSettings({ reminders: reminders.value.map((row) => ({ ...row })) })
}

async function toggle(row: ReminderSetting): Promise<void> {
  row.enabled = !row.enabled
  await persist()
  showToast({ message: row.enabled ? `已开启「${row.label}」` : `已关闭「${row.label}」`, position: 'bottom' })
}

async function askPermission(): Promise<void> {
  support.value = await requestNotificationPermission()
  showToast({
    message: support.value === 'granted' ? '已授权：应用打开时会按时间通知' : '浏览器没有授权通知',
    position: 'bottom'
  })
}

/** 周起始日只影响「哪一天算周末」（周报提醒），报告口径固定周一，见 `application/reminders.ts`。 */
async function setWeekStart(value: 1 | 7): Promise<void> {
  weekStart.value = value
  await saveSettings({ weekStart: value })
  showToast({ message: value === 1 ? '一周从周一起算' : '一周从周日起算', position: 'bottom' })
}

/** 改外观要**立刻**生效：写库只保证下次打开是对的，这次得当场应用（FR-1606）。 */
async function setTheme(value: ThemeChoice): Promise<void> {
  theme.value = value
  await saveSettings({ theme: value })
  applyTheme(value)
  showToast({ message: `外观：${themeLabel.value}`, position: 'bottom' })
}

/** 恢复追问：把字段从名单里拿掉（FR-1103「可随时恢复」）。 */
async function restoreField(field: string): Promise<void> {
  mutedFields.value = mutedFields.value.filter((item) => item !== field)
  await saveSettings({ mutedFields: mutedFields.value })
  showToast({ message: `「${field}」会重新开始追问`, position: 'bottom' })
}
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader title="设置" subtitle="全部开关都是本机的事，不上传任何东西" back />

    <div class="card">
      <h2 class="card-title">提醒</h2>
      <p class="muted">
        本应用<strong>没有服务端</strong>，所以做不了真正的推送（TD-09）：<strong>不提供日历 / .ics 导出</strong>，
        应用关着的时候也不会响。能用的只有两种：打开应用时的「今天还没记的」清单，
        以及系统支持且已授权时、应用打开着的时候按设定时间弹出的本地通知。
      </p>

      <div v-for="row in reminders" :key="row.id" class="reminder-row">
        <div class="reminder-head">
          <span class="reminder-label">{{ row.label }}</span>
          <van-switch :model-value="row.enabled" size="20" @update:model-value="toggle(row)" />
        </div>
        <div class="reminder-time">
          <input v-model="row.time" type="time" :disabled="!row.enabled" @change="persist()" />
          <span class="muted">{{ reminderHint(row.id) }}</span>
        </div>
      </div>

      <div class="kv">
        <span class="kv-key">系统通知</span>
        <span class="kv-value">{{ supportText }}</span>
      </div>
      <div class="actions">
        <van-button
          plain
          block
          :disabled="support !== 'default'"
          @click="askPermission"
        >
          {{ permissionButton }}
        </van-button>
      </div>
      <p class="muted">
        同一件事一天只会响一次；到了设定时间、而且那一项当天还没完成，才会通知（FR-1105）。
      </p>
    </div>

    <div class="card">
      <h2 class="card-title">偏好</h2>
      <div class="kv">
        <span class="kv-key">单位</span>
        <span class="kv-value">重量 kg · 能量 kcal</span>
      </div>
      <p class="muted">
        只支持 kg 与 kcal，不换算成斤或 kJ：记录口径统一，导出给仓库脚本才算得对（FR-1606）。
      </p>

      <div class="kv">
        <span class="kv-key">一周从哪天算起</span>
        <span class="kv-value">{{ weekStart === 1 ? '周一' : '周日' }}</span>
      </div>
      <div class="choice-row">
        <van-button size="small" :type="weekStart === 1 ? 'primary' : 'default'" @click="setWeekStart(1)">
          周一
        </van-button>
        <van-button size="small" :type="weekStart === 7 ? 'primary' : 'default'" @click="setWeekStart(7)">
          周日
        </van-button>
      </div>
      <p class="muted">
        它只决定「哪一天算这一周的最后一天」（周末那条周报提醒）；报告与趋势固定按周一起算，两边不冲突。
      </p>

      <div class="kv">
        <span class="kv-key">外观</span>
        <span class="kv-value">{{ themeLabel }}</span>
      </div>
      <div class="choice-row">
        <van-button
          v-for="item in THEME_CHOICES"
          :key="item.value"
          size="small"
          :type="theme === item.value ? 'primary' : 'default'"
          @click="setTheme(item.value)"
        >
          {{ item.label }}
        </van-button>
      </div>
      <p class="muted">选「跟随系统」时，系统切换深色会立刻跟上；这里改了也是立刻生效。</p>
    </div>

    <div class="card">
      <h2 class="card-title">不再追问的字段</h2>
      <p class="muted">
        「一句话记录」里这几个字段不会再被追问（FR-1103），随时可以放回去重新问。
        名单也能在「档案」页自由编辑（一行一条）。
      </p>
      <p v-if="!mutedFields.length" class="muted">名单是空的：该问的都会问。</p>
      <ul v-else class="muted-list">
        <li v-for="field in mutedFields" :key="field">
          <code>{{ field }}</code>
          <van-button size="mini" plain @click="restoreField(field)">恢复追问</van-button>
        </li>
      </ul>
      <div class="actions">
        <van-button size="small" plain block @click="$router.push('/profile')">去档案页编辑名单</van-button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">关于与免责声明</h2>
      <p class="muted">
        数据存在哪、估算值的边界、什么时候该去看医生 —— 都写在里面（需求 §9 / FR-1608）。
      </p>
      <div class="actions">
        <van-button size="small" plain block @click="$router.push('/about')">关于与免责声明</van-button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">模型</h2>
      <p class="muted">
        解析一句话 / 图片记录、生成报告与每日指导都走你自己配置的接口；token 只存本机，
        不进导出包、不写日志。
      </p>
      <div class="actions">
        <van-button type="primary" block @click="$router.push('/settings/model')">模型设置</van-button>
      </div>
    </div>

  </section>
</template>

<style scoped>
.reminder-row {
  padding: 10px 0;
  border-bottom: 1px dashed var(--border);
}

.reminder-row:last-of-type {
  border-bottom: none;
}

.reminder-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.reminder-label {
  font-size: 15px;
  font-weight: 600;
}

.reminder-time {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.reminder-time input {
  min-height: 34px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
}

.reminder-time input:disabled {
  opacity: 0.5;
}

.choice-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 6px 0 8px;
}

.muted-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
}

.muted-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
