import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from 'unplugin-vue-components/resolvers'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    Components({ resolvers: [VantResolver()], dts: 'src/components.d.ts' }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: '薄肌计划',
        short_name: '薄肌计划',
        description: '个人减脂增肌记录与决策工具',
        lang: 'zh-CN',
        // manifest 里的地址一律写**相对**的（不带前导斜杠）：它们按 manifest 自己的位置解析，
        // 于是根路径部署（`/`）与子路径部署（GitHub Pages 项目页 `/foodAndWorkout_deploy/`）
        // 用的是同一份 manifest —— 见 README 的「部署与分发」。
        start_url: 'today',
        scope: './',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#2f7d5b',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ],
        shortcuts: [
          { name: '记一餐', url: 'log/diet' },
          { name: '记体重', url: 'log/body' },
          { name: '今日汇总', url: 'summary' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        // 模型请求一律 network-only，不做任何缓存
        runtimeCaching: []
      },
      devOptions: { enabled: false }
    })
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  test: {
    // 默认 node：绝大多数是纯计算 / 解析测试，起 jsdom 反而慢一个数量级；
    // 需要 DOM 的用例在文件头用 `// @vitest-environment jsdom` 单独指定。
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.spec.ts'],
    // Vant 的组件是 ESM + 按需样式，必须让 Vite 处理它的 CSS，
    // 否则 jsdom 环境下会报 `Unknown file extension ".css"`。
    server: { deps: { inline: ['vant'] } }
  }
})
