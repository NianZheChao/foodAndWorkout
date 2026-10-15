import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { initializeApp } from './app/bootstrap'
// Toast / Dialog 是函数式组件，样式需要通过样式入口单独引入（Vant 4 的约定）
import 'vant/es/toast/style'
import 'vant/es/dialog/style'
import './style.css'

async function start(): Promise<void> {
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)

  // 启动流程（打开数据库、首次写入种子食物库）必须在挂载前完成，
  // 避免界面先渲染出空数据再被覆盖。
  try {
    const report = await initializeApp()
    app.provide('bootReport', report)
  } catch (error) {
    console.error('[boot] 初始化失败', error)
    app.provide('bootError', error instanceof Error ? error.message : String(error))
  }

  await router.isReady()
  app.mount('#app')
}

void start()
