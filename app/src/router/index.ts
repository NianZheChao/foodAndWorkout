import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'


/**
 * 页面清单对应 docs/pwa-design.md §8.1，按**域**分段排列（今日 / 记录 / 分析 / 我的 / 设置）。
 *
 * 归属与顺序的权威在 `app/src/app/nav.ts` 的导航树里（tab 高亮、页头导航条、面包屑都读它）；
 * 这里的注释只是让人一眼对上。**两边必须一一对应**：`tests/navigation-reachability.spec.ts`
 * 拿本文件的路由表逐条比对导航树。
 *
 * 阶段 4 起**所有路由都有真页面**了（T4.5 把最后一个占位页 `/settings` 换掉），
 * 所以 `PlaceholderPage.vue` 已经退休 —— 再加占位页时记得先把它登记进导航树，
 * 否则 `tests/navigation-reachability.spec.ts` 会拦下来。
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/today' },

  // 今日：今天的进度、指导与推荐（域根 `/today`）
  { path: '/today', name: 'today', component: () => import('@/pages/TodayPage.vue'), meta: { title: '今日' } },
  { path: '/summary/:date?', name: 'summary', component: () => import('@/pages/SummaryPage.vue'), meta: { title: '当日汇总', spec: 'M5 FR-500' } },
  {
    path: '/coach',
    name: 'coach',
    component: () => import('@/pages/CoachPage.vue'),
    meta: { title: '今日指导', spec: 'M8 A 级 / §6.4.2' }
  },
  {
    path: '/plan',
    name: 'plan',
    component: () => import('@/pages/PlanPage.vue'),
    meta: { title: '推荐清单', spec: 'M8 B 级 FR-801~807 / §6.5 / §6.6' }
  },

  // 记录：三块面板（饮食 / 训练 / 身体）共用一个壳（LogHubPage），日期由它统一持有。
  // 域根就是**饮食面板**（`/log/diet`）—— 以前 `/log` 与 `/log/diet` 各是一条路由、
  // 渲染的是同一个面板，页头那条导航条于是并排出现「记录」「饮食」两颗同样的格子。
  { path: '/log', redirect: '/log/diet' },
  { path: '/log/quick', name: 'log-quick', component: () => import('@/pages/LogQuickPage.vue'), meta: { title: '一句话 / 拍照记录', spec: 'FR-110 / FR-111 / FR-113' } },
  { path: '/log/:kind(diet|workout|body)', name: 'log', component: () => import('@/pages/LogHubPage.vue'), meta: { title: '记录', spec: 'M1 FR-100 / M2 FR-200 / M3 FR-300' } },
  { path: '/foods', name: 'foods', component: () => import('@/pages/FoodsPage.vue'), meta: { title: '食物库', spec: 'M4 FR-400' } },

  // 分析：看数据（趋势 / 报告）与调目标（目标 / 校准）
  { path: '/trend', name: 'trend', component: () => import('@/pages/TrendPage.vue'), meta: { title: '趋势', spec: 'M6 FR-600' } },
  { path: '/reports', name: 'reports', component: () => import('@/pages/ReportsPage.vue'), meta: { title: '报告', spec: 'M7 FR-700' } },
  {
    path: '/reports/:id',
    name: 'report-detail',
    component: () => import('@/pages/ReportDetailPage.vue'),
    meta: { title: '报告详情', spec: 'M7 FR-700 / FR-710' }
  },
  { path: '/targets', name: 'targets', component: () => import('@/pages/TargetsPage.vue'), meta: { title: '目标', spec: 'M9 FR-900' } },
  {
    path: '/calibration',
    name: 'calibration',
    component: () => import('@/pages/CalibrationPage.vue'),
    meta: { title: '校准向导', spec: 'M9 FR-903~905 / §6.7' }
  },

  // 我的：档案、我的数据（导出 / 导入 / 快照）与关于
  { path: '/me', name: 'me', component: () => import('@/pages/MePage.vue'), meta: { title: '我的', spec: 'M10 FR-1000 / M12 FR-1200 / M16 FR-1608' } },
  { path: '/profile', name: 'profile', component: () => import('@/pages/ProfilePage.vue'), meta: { title: '档案', spec: 'M10 FR-1000' } },
  { path: '/data', name: 'data', component: () => import('@/pages/DataPage.vue'), meta: { title: '数据', spec: 'M12 FR-1200 / §7' } },
  {
    path: '/about',
    name: 'about',
    component: () => import('@/pages/AboutPage.vue'),
    meta: { title: '关于与免责声明', spec: 'M16 FR-1608 / 需求 §9' }
  },

  // 设置：应用怎么跑（模型与 AI / 提醒 / 偏好与外观）
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/pages/SettingsPage.vue'),
    meta: { title: '设置', spec: 'M16 FR-1600 / M11 FR-1101' }
  },
  { path: '/settings/model', name: 'settings-model', component: () => import('@/pages/ModelSettingsPage.vue'), meta: { title: '模型设置', spec: 'M13 FR-1300' } }
]
export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})
