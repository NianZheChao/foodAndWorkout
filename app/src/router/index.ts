import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const Placeholder = () => import('@/pages/PlaceholderPage.vue')

/** 页面清单对应 docs/pwa-design.md §8.1。阶段 1 已落地今日 / 记录 / 汇总，其余先占位。 */
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/today' },
  { path: '/today', name: 'today', component: () => import('@/pages/TodayPage.vue'), meta: { title: '今日' } },
  { path: '/log/quick', name: 'log-quick', component: () => import('@/pages/LogQuickPage.vue'), meta: { title: '一句话 / 拍照记录', spec: 'FR-110 / FR-111 / FR-113' } },
  // 「记录」tab：一个入口 + 顶部子 tab（饮食 / 训练 / 身体），见 docs/pwa-design.md §8.1
  { path: '/log/:kind(diet|workout|body)?', name: 'log', component: () => import('@/pages/LogHubPage.vue'), meta: { title: '记录', spec: 'M1 FR-100 / M2 FR-200 / M3 FR-300' } },
  { path: '/summary/:date?', name: 'summary', component: () => import('@/pages/SummaryPage.vue'), meta: { title: '当日汇总', spec: 'M5 FR-500' } },
  { path: '/trend', name: 'trend', component: () => import('@/pages/TrendPage.vue'), meta: { title: '趋势', spec: 'M6 FR-600' } },
  { path: '/reports', name: 'reports', component: () => import('@/pages/ReportsPage.vue'), meta: { title: '报告', spec: 'M7 FR-700' } },
  {
    path: '/reports/:id',
    name: 'report-detail',
    component: () => import('@/pages/ReportDetailPage.vue'),
    meta: { title: '报告详情', spec: 'M7 FR-700 / FR-710' }
  },
  { path: '/foods', name: 'foods', component: Placeholder, meta: { title: '食物库', spec: 'M4 FR-400' } },
  { path: '/targets', name: 'targets', component: () => import('@/pages/TargetsPage.vue'), meta: { title: '目标', spec: 'M9 FR-900' } },
  { path: '/profile', name: 'profile', component: () => import('@/pages/ProfilePage.vue'), meta: { title: '档案', spec: 'M10 FR-1000' } },
  { path: '/settings', name: 'settings', component: Placeholder, meta: { title: '设置', spec: 'M16 FR-1600' } },
  { path: '/settings/model', name: 'settings-model', component: () => import('@/pages/ModelSettingsPage.vue'), meta: { title: '模型设置', spec: 'M13 FR-1300' } },
  { path: '/data', name: 'data', component: Placeholder, meta: { title: '数据', spec: 'M12 FR-1200' } }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})
