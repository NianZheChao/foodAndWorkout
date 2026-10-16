/**
 * 导航树（单一数据源）：**域 → 页面**。
 *
 * 起因（2026-10-16）：页面各自为政，入口写在随手加的按钮上 —— 「今日指导」只能从
 * 「生成今日指导」那个按钮进，档案 / 目标 / 数据 / 模型设置散在「今日页 → 更多」里，
 * 还有一批页面（`/coach` `/plan` `/foods` `/targets` `/calibration` `/profile` `/data`）
 * 不属于任何底部 tab，走进去连高亮都没有。加一个页面就得记得补一处入口，迟早漏（漏过一次）。
 *
 * 现在改成**先声明树、再渲染**：
 * - 底部 tab = 五个域（`navDomains`），高亮前缀 `match` 必须覆盖本域全部页面；
 * - 每个页面的页头自动渲染一条**本域导航条**（`navLocation().chips`），单页也有兄弟入口；
 * - 层级 ≥ 3 的页面（如报告详情）额外给一条面包屑（`navLocation().crumbs`）。
 *
 * 因此**新增页面必须在这里登记**，否则它既不高亮、也没有入口 —— `tests/navigation-reachability.spec.ts`
 * 拿路由表逐条比对，漏登记会直接测试失败（比在界面上发现要便宜得多）。
 */

export interface NavPage {
  /** 导航树里的唯一标识（面包屑的 `parent` 用它做父子引用） */
  id: string
  label: string
  /** 路由路径；带参数的写 `:id`（如 `/reports/:id`） */
  path: string
  /** 与 `router/index.ts` 的 `name` 一致：按路径匹配不上时用它兜底（详情页靠这个） */
  routerName: string
  /** 上级页面的 id；只有层级 ≥ 3 的页面需要（会决定面包屑） */
  parent?: string
  /** 不进导航条：只能从上级页面进（例如依赖参数的详情页） */
  hidden?: boolean
}

export interface NavDomain {
  key: string
  label: string
  /** Vant 图标名（底部 tab 用） */
  icon: string
  /** 域根页：底部 tab 的跳转目标，也是面包屑的第一级 */
  root: string
  rootName: string
  /**
   * 域根那颗格子的文案，缺省用域的名字（`label`）。
   * 「记录」域是唯一用到的：它的根页就是饮食面板，格子写「饮食」比写「记录」更准
   * （写「记录」时它和 tab 同名、又和旁边的「饮食」指同一个页面，等于两个名字一件事）。
   */
  rootLabel?: string
  /** 高亮前缀：必须覆盖本域**全部**页面（含详情页） */
  match: string[]
  /** 域内其它页面（不含域根：域根由底部 tab 代表） */
  pages: NavPage[]
}

export const navDomains: NavDomain[] = [
  {
    key: 'today',
    label: '今日',
    icon: 'wap-home-o',
    root: '/today',
    rootName: 'today',
    match: ['/today', '/summary', '/coach', '/plan'],
    pages: [
      { id: 'summary', label: '当日汇总', path: '/summary', routerName: 'summary' },
      { id: 'coach', label: '今日指导', path: '/coach', routerName: 'coach' },
      { id: 'plan', label: '推荐清单', path: '/plan', routerName: 'plan' }
    ]
  },
  {
    key: 'log',
    label: '记录',
    icon: 'records-o',
    // 根页就是饮食面板（`/log` 只是它的旧地址，在路由表里 302 到 `/log/diet`）——
    // 以前根页与「饮食」是两颗指向同一个页面的格子，页头上「记录」「饮食」并排出现
    root: '/log/diet',
    rootName: 'log',
    rootLabel: '饮食',
    match: ['/log', '/foods'],
    pages: [
      { id: 'log-workout', label: '训练', path: '/log/workout', routerName: 'log' },
      { id: 'log-body', label: '身体', path: '/log/body', routerName: 'log' },
      { id: 'log-quick', label: '一句话记录', path: '/log/quick', routerName: 'log-quick' },
      { id: 'foods', label: '食物库', path: '/foods', routerName: 'foods' }
    ]
  },
  {
    key: 'analysis',
    label: '分析',
    icon: 'chart-trending-o',
    root: '/trend',
    rootName: 'trend',
    match: ['/trend', '/reports', '/targets', '/calibration'],
    pages: [
      { id: 'reports', label: '报告', path: '/reports', routerName: 'reports' },
      { id: 'targets', label: '目标与校准', path: '/targets', routerName: 'targets' },
      { id: 'calibration', label: '校准向导', path: '/calibration', routerName: 'calibration' },
      {
        id: 'report-detail',
        label: '报告详情',
        path: '/reports/:id',
        routerName: 'report-detail',
        parent: 'reports',
        hidden: true
      }
    ]
  },
  {
    key: 'me',
    label: '我的',
    icon: 'user-o',
    root: '/me',
    rootName: 'me',
    match: ['/me', '/profile', '/data', '/about'],
    pages: [
      { id: 'profile', label: '档案', path: '/profile', routerName: 'profile' },
      { id: 'data', label: '数据', path: '/data', routerName: 'data' },
      { id: 'about', label: '关于与免责声明', path: '/about', routerName: 'about' }
    ]
  },
  {
    key: 'settings',
    label: '设置',
    icon: 'setting-o',
    root: '/settings',
    rootName: 'settings',
    match: ['/settings'],
    pages: [
      { id: 'settings-model', label: '模型与 AI', path: '/settings/model', routerName: 'settings-model' }
    ]
  }
]

/** 底部 tab（域）的顺序与文案，由 `navDomains` 派生 */
export const navTabs = navDomains.map((domain) => ({
  name: domain.key,
  label: domain.label,
  icon: domain.icon,
  to: domain.root
}))

/** 路径落在哪个域：`match` 是前缀，但要按**整段**比（`/me` 不该匹配 `/member`）。 */
export function domainOf(path: string): NavDomain | undefined {
  return navDomains.find((domain) =>
    domain.match.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  )
}

/** 路径是否命中某条导航页（`:id` 段按单段通配）。 */
function hits(pattern: string, path: string): boolean {
  if (!pattern.includes(':')) return pattern === path
  const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`)
  return regex.test(path)
}

export interface NavChip {
  label: string
  path: string
  active: boolean
}

export interface NavCrumb {
  label: string
  /** 没有 `path` 的是当前页（不可点） */
  path?: string
}

export interface NavLocation {
  domain?: NavDomain
  page?: NavPage
  /** 本域导航条（含域根）：域根页上是「本域目录」，二级页上是「同层还有谁」 */
  chips: NavChip[]
  /** 面包屑：只在层级 ≥ 3 时给（域 › 上级页 › 当前页） */
  crumbs: NavCrumb[]
}

/**
 * 按当前路由算出「我在哪、同层还有谁」。
 *
 * 先按路径匹配（`/log/diet` 这种同名的子页只能靠路径区分），匹配不上再按路由名兜底
 * （`/reports/rep_x` 这类带参数的详情页）。
 */
export function navLocation(path: string, routerName?: string | null): NavLocation {
  const domain = domainOf(path)
  if (!domain) return { chips: [], crumbs: [] }

  const page =
    domain.pages.find((item) => hits(item.path, path)) ??
    domain.pages.find((item) => item.routerName === routerName)

  const chips: NavChip[] = [
    { label: domain.rootLabel ?? domain.label, path: domain.root, active: path === domain.root },
    ...domain.pages
      .filter((item) => !item.hidden)
      .map((item) => ({
        label: item.label,
        path: item.path,
        // 详情页没有自己的格子，高亮它的上级（否则整条导航条一个都不亮）
        active: item.path === path || item.id === page?.parent
      }))
  ]

  const crumbs: NavCrumb[] = []
  const parent = page?.parent ? domain.pages.find((item) => item.id === page.parent) : undefined
  if (page?.parent && parent) {
    crumbs.push({ label: domain.label, path: domain.root }, { label: parent.label, path: parent.path }, { label: page.label })
  }

  return { domain, page, chips, crumbs }
}