// @vitest-environment jsdom
/**
 * 部署路径的护栏（2026-10-16）：路由 base 必须跟着 Vite 的 `BASE_URL` 走。
 *
 * 为什么单独盯这一条：`createWebHistory()` 留空时，vue-router 只认 `<base href>` 或 `/`，
 * 而 `index.html` 里没有 `<base>` 标签 —— 于是子路径部署（GitHub Pages 项目页 `/<repo>/`）下
 * 应用以为自己在站根，`router.push('/today')` 把地址栏改成 `https://<owner>.github.io/today`。
 * `pushState` 不刷新页面，所以**本地开发（base 就是 `/`）与页面内跳转全都看不出来**，
 * 只有在子路径下刷新才暴露：请求打到用户站根，被那边的博客 404 页接走。
 *
 * 手法：`vi.stubEnv` 把 `BASE_URL` 换成子路径后再重新 import 路由模块（base 在模块顶层定死），
 * 相当于把「子路径部署」整个跑一遍。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { navTabs } from '../src/app/nav'

/** 换掉 Vite 的 `BASE_URL` 后重新 import 路由：base 在模块顶层 `createRouter` 时就定下来了。 */
async function routerAt(base: string) {
  vi.stubEnv('BASE_URL', base)
  vi.resetModules()
  const { router } = await import('../src/router/index')
  return router
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('路由 base 跟着部署路径走', () => {
  it('子路径部署（/foodAndWorkout_deploy/）时站内地址不越出应用目录', async () => {
    const router = await routerAt('/foodAndWorkout_deploy/')

    expect(router.options.history.base).toBe('/foodAndWorkout_deploy')
    expect(router.resolve('/today').href).toBe('/foodAndWorkout_deploy/today')

    // 底部五个 tab 与二级页都得留在应用里：越出去的那个地址一刷新就是别人的站
    for (const tab of navTabs) {
      expect(router.resolve(tab.to).href.startsWith('/foodAndWorkout_deploy/')).toBe(true)
    }
    for (const path of ['/log/diet', '/foods', '/trend', '/reports/abc', '/settings/model']) {
      expect(router.resolve(path).href.startsWith('/foodAndWorkout_deploy/')).toBe(true)
    }
  })

  it('根路径部署（自有域名 / 本地开发）不受影响', async () => {
    const router = await routerAt('/')
    expect(router.resolve('/today').href).toBe('/today')
  })

  it('对不上的路径回落到今日页，不留白屏', async () => {
    const router = await routerAt('/')
    for (const path of ['/index.html', '/nope', '/foods/deep/nope']) {
      await router.push(path)
      expect(router.currentRoute.value.path).toBe('/today')
    }
  })
})