<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import { runQueue } from '@/application/queue'
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

onMounted(() => {
  void drainQueue()
  window.addEventListener('online', () => void drainQueue())
})

/**
 * 底部五个入口（docs/pwa-design.md §8.1）。
 *
 * 这里有两处专门为「能不能回到首页」服务：
 * 1. 高亮按**前缀分组**匹配：`/log/*` 全都归到「记录」，不会因为匹配不上而退回高亮「今日」。
 * 2. 跳转一律走 `@click`，不依赖 tabbar 的 `change` 事件——`change` 只在选中项**变化**时触发，
 *    点一个已经高亮的 tab 就成了死键，用户会直接卡在没有返回入口的页面上。
 */
const tabs = [
  { name: 'today', label: '今日', icon: 'wap-home-o', to: '/today', match: ['/today', '/summary'] },
  { name: 'log', label: '记录', icon: 'records-o', to: '/log', match: ['/log'] },
  { name: 'trend', label: '趋势', icon: 'chart-trending-o', to: '/trend', match: ['/trend'] },
  { name: 'reports', label: '报告', icon: 'notes-o', to: '/reports', match: ['/reports'] },
  { name: 'settings', label: '设置', icon: 'setting-o', to: '/settings', match: ['/settings'] }
]

const activeIndex = computed(() => {
  // 匹配不到任何分组时不高亮（-1）；因为跳转走 click，仍然点得动，不会卡住
  return tabs.findIndex((tab) => tab.match.some((prefix) => route.path.startsWith(prefix)))
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
