import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * 页面清单对应 docs/pwa-design.md §8.1。
 *
 * 阶段 4 起**所有路由都有真页面**了（T4.5 把最后一个占位页 `/settings` 换掉），
 * 所以 `PlaceholderPage.vue` 已经退休 —— 再加占位页时记得同时给它留下入口，
 * 否则 `tests/navigation-reachability.spec.ts` 会拦下来。
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/today' },
  { path: '/today', name: 'today', component: () => import('@/pages/TodayPage.vue'), meta: { title: '今日' } },
  { path: '/log/quick', name: 'log-quick', component: () => import('@/pages/LogQuickPage.vue'), meta: { title: '一句话 / 拍照记录', spec: 'FR-110 / FR-111 / FR-113' } },
  // 「记录」tab：一个入口 + 顶部子 tab（饮食 / 训练 / 身体），见 docs/pwa-design.md §8.1
  { path: '/log/:kind(diet|workout|body)?', name: 'log', component: () => import('@/pages/LogHubPage.vue'), meta: { title: '记录', spec: 'M1 FR-100 / M2 FR-200 / M3 FR-300' } },
  { path: '/summary/:date?', name: 'summary', component: () => import('@/pages/SummaryPage.vue'), meta: { title: '当日汇总', spec: 'M5 FR-500' } },
  { path: '/trend', name: 'trend', component: () => import('@/pages/TrendPage.vue'), meta: { title: '趋势', spec: 'M6 FR-600' } },
  {
    path: '/coach',
    name: 'coach',
    component: () => import('@/pages/CoachPage.vue'),
    meta: { title: '今日指导', spec: 'M8 A 级 / §6.4.2' }
  },
  { path: '/reports', name: 'reports', component: () => import('@/pages/ReportsPage.vue'), meta: { title: '报告', spec: 'M7 FR-700' } },
  {
    path: '/reports/:id',
    name: 'report-detail',
    component: () => import('@/pages/ReportDetailPage.vue'),
    meta: { title: '报告详情', spec: 'M7 FR-700 / FR-710' }
  },
  { path: '/foods', name: 'foods', component: () => import('@/pages/FoodsPage.vue'), meta: { title: '食物库', spec: 'M4 FR-400' } },
  { path: '/targets', name: 'targets', component: () => import('@/pages/TargetsPage.vue'), meta: { title: '目标', spec: 'M9 FR-900' } },
  {
    path: '/calibration',
    name: 'calibration',
    component: () => import('@/pages/CalibrationPage.vue'),
    meta: { title: '校准向导', spec: 'M9 FR-903~905 / §6.7' }
  },
  { path: '/profile', name: 'profile', component: () => import('@/pages/ProfilePage.vue'), meta: { title: '档案', spec: 'M10 FR-1000' } },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/pages/SettingsPage.vue'),
    meta: { title: '设置', spec: 'M16 FR-1600 / M11 FR-1101' }
  },
  { path: '/settings/model', name: 'settings-model', component: () => import('@/pages/ModelSettingsPage.vue'), meta: { title: '模型设置', spec: 'M13 FR-1300' } },
  {
    path: '/about',
    name: 'about',
    component: () => import('@/pages/AboutPage.vue'),
    meta: { title: '关于与免责声明', spec: 'M16 FR-1608 / 需求 §9' }
  },
  {
    path: '/data',
    name: 'data',
    component: () => import('@/pages/DataPage.vue'),
    meta: { title: '数据', spec: 'M12 FR-1200 / §7' }
  }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})
