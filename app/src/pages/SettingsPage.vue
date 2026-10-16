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
import { mergeReminders, reminderHint } from '@/domain/reminders'
import type { ReminderSetting } from '@/domain/types'

const SUPPORT_TEXT: Record<NotificationSupport, string> = {
  unsupported: '这台设备 / 浏览器不支持系统通知：只会有应用内提醒。',
  default: '还没有授权：点下面的按钮申请。iOS 上要先把应用「添加到主屏幕」再打开，否则没有通知可用。',
  granted: '已授权：应用打开着的时候，到了设定时间会弹一条通知。',
  denied: '已被拒绝：需要到浏览器的站点设置里改回来，或只用应用内提醒。'
}

const reminders = ref<ReminderSetting[]>([])
const support = ref<NotificationSupport>('unsupported')
const loaded = ref(false)

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
      <h2 class="card-title">模型</h2>
      <p class="muted">
        解析一句话 / 图片记录、生成报告与每日指导都走你自己配置的接口；token 只存本机，
        不进导出包、不写日志。
      </p>
      <div class="actions">
        <van-button type="primary" block @click="$router.push('/settings/model')">模型设置</van-button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">还没做的部分</h2>
      <p class="muted">这些属于 T4.6，现在先把位置与需求编号写在这里，免得找不到入口：</p>
      <ul class="hint-list">
        <li>单位与周起始日：字段已存在，界面没做（FR-1601）</li>
        <li>外观（浅色 / 深色 / 跟随系统）：字段已存在，界面没做（FR-1603）</li>
        <li>「不再追问」名单：机制可用，入口暂时留在档案页（FR-1103）</li>
        <li>免责声明与诊断信息导出：需求 §9 / FR-1608</li>
      </ul>
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
</style>
