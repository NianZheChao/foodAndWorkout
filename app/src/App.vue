<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import { runQueue } from '@/application/queue'
import { startReminderLoop } from '@/application/notify'
import { domainOf, navTabs } from '@/app/nav'
import { applyThemeFromSettings, startThemeSync } from '@/app/theme'
import InstallHint from '@/components/InstallHint.vue'

const route = useRoute()
const router = useRouter()

/**
 * 待办队列在启动与网络恢复时自动重放（§6.10）。
 * 没配模型或离线时 `runQueue` 直接返回，不会发请求、也不会写任何数据。
 */
async function drainQueue(): Promise<void> {
  try {
    const report = await runQueue()
    const message = report.messages[report.messages.length - 1]
    if (report.done && message) showToast({ message, position: 'bottom' })
  } catch {
    // 队列重放失败不能影响打开应用
  }
}

/**
 * 提醒的本地通知（T4.5 / FR-1101）：应用打开期间每分钟检查一次到点未完成的事项。
 * 没授权 / 不支持时整条链路静默跳过，应用内提醒不受影响（FR-1104）。
 */
let stopReminders: (() => void) | undefined
/** 外观（FR-1606）：启动时按设置写一次 `data-theme`，「跟随系统」时订阅系统配色变化 */
let stopTheme: (() => void) | undefined

onMounted(async () => {
  void drainQueue()
  window.addEventListener('online', drainQueue)
  stopReminders = startReminderLoop()
  await applyThemeFromSettings()
  stopTheme = startThemeSync()
})

onUnmounted(() => {
  window.removeEventListener('online', drainQueue)
  stopReminders?.()
  stopTheme?.()
})

/**
 * 底部五个入口 = 五个**域**（docs/pwa-design.md §8.1），直接取自 `app/nav.ts` 的导航树：
 * 加页面、改归属只改那一处，tab 的文案与高亮范围跟着一起变。
 *
 * 这里有两处专门为「能不能回到首页」服务：
 * 1. 高亮按**域**匹配（`domainOf`）：`/log/*` 与 `/foods` 都归「记录」、`/reports/:id` 归「分析」，
 *    不再有页面匹配不上、连个高亮都没有（重构前有七个）。
 * 2. 跳转一律走 `@click`，不依赖 tabbar 的 `change` 事件——`change` 只在选中项**变化**时触发，
 *    点一个已经高亮的 tab 就成了死键，用户会直接卡在没有返回入口的页面上。
 */
const tabs = navTabs

const activeIndex = computed(() => {
  // 匹配不到任何域时不高亮（-1）；因为跳转走 click，仍然点得动，不会卡住
  const domain = domainOf(route.path)
  return domain ? tabs.findIndex((tab) => tab.name === domain.key) : -1
})

function go(to: string): void {
  if (route.path !== to) void router.push(to)
}
</script>

<template>
  <div class="app-shell">
    <main class="app-main">
      <InstallHint v-if="route.path === '/today'" />
      <router-view />
    </main>
    <van-tabbar :model-value="activeIndex">
      <van-tabbar-item v-for="item in tabs" :key="item.name" :icon="item.icon" @click="go(item.to)">
        {{ item.label }}
      </van-tabbar-item>
    </van-tabbar>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-main {
  flex: 1;
  /* 独立窗口（装到主屏）时避开刘海与底部横条 */
  padding-top: env(safe-area-inset-top);
  padding-bottom: calc(50px + env(safe-area-inset-bottom));
}
</style>
