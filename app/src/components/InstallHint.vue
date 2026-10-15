<script setup lang="ts">
/**
 * 「添加到主屏幕」引导（T0.2 / FR-1501）。
 *
 * 只在**还没装**的时候出现，且只出现一次（关掉就记住）。分工：
 * - Chromium：抓到 `beforeinstallprompt` 就留一个按钮，点了调原生安装弹窗；
 * - iOS Safari：没有安装事件可用，只能写清楚「分享 → 添加到主屏」这条路（FR-1510）。
 *
 * localStorage 只放「提示已关掉」这一条 UI 偏好，业务数据一律在 IndexedDB（TD-08）。
 */

import { computed, onMounted, onBeforeUnmount, ref } from 'vue'

const STORAGE_KEY = 'thinMusclePlan.installHintDismissed'

/** `beforeinstallprompt` 还没进 TS 的标准 DOM 类型，这里按用到的最小面来自定义。 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const deferred = ref<InstallPromptEvent>()
const dismissed = ref(true)
const isIos = ref(false)

function isStandalone(): boolean {
  const byMedia =
    typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
  const byNavigator = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return byMedia || byNavigator
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // 隐私模式下 localStorage 可能直接抛异常，那就每次都提示，不崩
    return false
  }
}

function onBeforeInstallPrompt(event: Event): void {
  event.preventDefault()
  deferred.value = event as InstallPromptEvent
}

onMounted(() => {
  if (isStandalone()) return
  dismissed.value = readDismissed()
  isIos.value = /iPad|iPhone|iPod/.test(navigator.userAgent)
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.addEventListener('appinstalled', onInstalled)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.removeEventListener('appinstalled', onInstalled)
})

const visible = computed(() => !dismissed.value && !isStandalone())

/** 装好了就不再提示（Chromium 会发 `appinstalled`）。 */
function onInstalled(): void {
  deferred.value = undefined
  dismiss()
}

function dismiss(): void {
  dismissed.value = true
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // 存不下就算了，下次再提示一遍不影响使用
  }
}

async function install(): Promise<void> {
  const event = deferred.value
  if (!event) return
  await event.prompt()
  const choice = await event.userChoice
  if (choice?.outcome === 'accepted') dismiss()
}
</script>

<template>
  <div v-if="visible" class="install-hint">
    <div class="install-text">
      <strong>装到主屏幕</strong>
      <p v-if="isIos" class="muted">
        iOS 要在 Safari 里手动添加：点底部的「分享」→「添加到主屏」。装好后可以离线打开、像 App 一样用。
      </p>
      <p v-else-if="deferred" class="muted">装到主屏后可以离线打开，记一笔不用先找浏览器。</p>
      <p v-else class="muted">
        在浏览器菜单里选「安装应用 / 添加到主屏」即可；装好后可以离线打开。
      </p>
    </div>
    <div class="install-actions">
      <van-button v-if="deferred && !isIos" size="small" type="primary" @click="install">
        安装
      </van-button>
      <van-button size="small" plain @click="dismiss">知道了</van-button>
    </div>
  </div>
</template>

<style scoped>
.install-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 16px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--brand-soft);
}

.install-text strong {
  font-size: 14px;
}

.install-text p {
  margin: 4px 0 0;
}

.install-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}
</style>
