# 薄肌计划（PWA）设计文档

| 项目 | 内容 |
| --- | --- |
| 产品名称 | 薄肌计划 |
| 文档版本 | v0.1（技术设计） |
| 日期 | 2026-10-15 |
| 上游文档 | `docs/pwa-requirements.md`（v0.2），本文中的 FR-xxx / DR-xxx 均指该文档编号 |
| 状态 | 待评审 |
| 范围 | 架构、数据模型、计算引擎、大模型集成、导入导出、界面、离线、测试与实施计划 |

---

## 1. 决策摘要

### 1.1 已拍板的产品决策（来自需求文档 §12）

| 编号 | 决策 |
| --- | --- |
| OQ-1 | 多端只做 **导入 / 导出**，不做自动同步 |
| OQ-2 | 只支持 **OpenAI 兼容接口**（`{baseUrl}/chat/completions`），不做自定义请求模板 |
| OQ-7 | **按风险分级采纳**：营养数据与目标改动需用户确认；报告文字生成后可直接编辑 |
| OQ-8 | **不做日历 / .ics 提醒导出**：提醒只保留应用内提醒 + 本地通知能力探测 | 见 §9.4；`.ics` 生成与导入引导均不实现 |

### 1.2 本文新增的技术决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| TD-01 | 纯前端 SPA + 静态托管，**零后端、零服务端存储** | 需求 P-01；也意味着无需运维，部署成本为零 |
| TD-02 | Vue 3 + TypeScript + Vite 构建 | 单人维护、中文生态成熟、移动端组件库齐全；与 React 可互换，不作为硬约束 |
| TD-03 | 以 **Dexie 4** 封装 IndexedDB | 原生 API 冗长易错；Dexie 提供版本迁移、索引查询、事务与 TypeScript 类型 |
| TD-04 | 领域计算与界面**彻底解耦**为 `domain/` 纯函数层 | 便于与 `scripts/nutrition.py` 逐项对拍，也便于单测 |
| TD-05 | 模型任务采用**任务注册表 + Zod 契约** | 每个任务的请求模板、输出 schema、校验规则、token 上限集中声明 |
| TD-06 | 模型响应一律**先解析、再校验、后落库**，失败不写入任何数据 | 需求 DR-43 / DR-44、FR-1403 / FR-1405 |
| TD-07 | 报告采用**本地摘要 → 模型表达**，并加**数字一致性守卫** | 需求 FR-1411、DR-37；省 token 且杜绝幻觉数字 |
| TD-08 | IndexedDB 之外不引入任何本地存储（不把业务数据放 localStorage） | 单点数据源，避免双写不一致 |
| TD-09 | 提醒在无后端前提下**不依赖 Web Push，也不做日历导出**，只保留应用内提醒 + 系统支持时的本地通知 | 见 §9.4；2026-10-15 按用户要求去掉 `.ics` 方案 |
| TD-10 | Markdown 解析 / 生成作为**导入导出通道**，不作为主存储 | 运行时用结构化对象，导出时再生成契约文本 |

---

## 2. 架构总览

### 2.1 分层

```
┌──────────────────────────────────────────────────────────┐
│  ui/            页面与组件（Vue SFC）                      │
│                 Tabbar / 表单 / 图表 / 报告渲染            │
├──────────────────────────────────────────────────────────┤
│  store/         Pinia 状态（会话态、当前日、队列计数）      │
├──────────────────────────────────────────────────────────┤
│  application/   用例编排：记一餐、完成一天、生成周报…        │
│                 事务边界、队列调度、确认流程                │
├───────────────┬──────────────────────┬───────────────────┤
│  domain/      │  llm/                │  io/              │
│  纯计算        │  客户端、任务注册表    │  Markdown 读写     │
│  营养/训练/体重 │  校验、重试、缓存      │  导出包 / 导入     │
│  汇总/趋势/TDEE│  用量统计、队列        │                   │
├───────────────┴──────────────────────┴───────────────────┤
│  data/          Dexie schema、仓储（repository）、迁移      │
├──────────────────────────────────────────────────────────┤
│  IndexedDB      唯一持久层（对象存储见 §4.1）               │
└──────────────────────────────────────────────────────────┘
                     ↕ 唯一外部依赖
        OpenAI 兼容接口（用户自备 URL + token）
```

关键约束：**数据流单向向下**。`domain/` 不得 import `llm/`、`io/` 或 `ui/`；`llm/` 不得直接写库，只能返回经过校验的候选结果，由 `application/` 决定是否落库。

### 2.2 两条主链路

| 链路 | 触发 | 路径 | 是否联网 |
| --- | --- | --- | --- |
| 记录链路 | 用户录入 | ui → application → domain（换算/汇总）→ data → IndexedDB | 否（未命中食物库时才请求模型） |
| 生成链路 | 用户点「生成周报」 | ui → application → domain（本地聚合摘要）→ llm（请求/校验）→ data（落库报告） | 是 |

### 2.3 与现有工作区的关系

> 口径见 2026-10-15 的仓库转型：**本仓库只放 app**。原本的 `records/`、`plans/`、`reviews/`、
> `profile.md`、`targets.md` 与 skills 已移出（个人数据不进仓库）；下面这张表说的是**格式契约**层面的
> 关系 —— 使用者在别处维护的那套 Markdown 结构仍然是导入 / 导出的目标，字段与口径不变。

| 现有资产 | 在新架构中的角色 |
| --- | --- |
| `data/foods.csv` | 构建期内联为初始食物库种子（114 条），首次启动写入 IndexedDB |
| `records/*.md`、`plans/`、`reviews/` | 导入源与导出目标，由 `io/` 处理 |
| `scripts/nutrition.py` | **不是运行时依赖**，而是 `domain/` 的验收基准（对拍测试，见 §5.3） |
| `README.md` 格式契约 | `io/` 的解析与生成依据 |
---

## 3. 技术选型

| 领域 | 选型 | 理由 | 替代方案 |
| --- | --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） | 单人维护成本低、生态与中文文档成熟 | React / Svelte |
| 构建 | Vite | 与 Vue 3 一等公民，构建快，产物为纯静态文件 | — |
| PWA | `vite-plugin-pwa`（内部 Workbox） | 声明式生成 manifest 与 Service Worker，支持 precache 与更新策略 | 手写 Service Worker |
| 路由 | Vue Router（history 模式） | 页面清单见需求 §7 | — |
| 状态 | Pinia | 轻量、TS 友好；只存会话态与派生态，不存业务数据集 | 直接用 composables |
| 本地库 | Dexie 4 | 版本迁移、索引、事务、`liveQuery` 响应式 | 原生 IndexedDB / idb |
| 校验 | Zod | 同一套 schema 复用于模型输出校验与导入包校验 | 手写校验器 |
| 图表 | ECharts（按需引入） | 移动端折线 / 柱状表现好，体积可控 | Chart.js / 自绘 SVG |
| UI 组件 | Vant 4 + 少量自研组件 | 移动优先、中文文档、体积可控 | NutUI / 纯自研 |
| 日期 | dayjs（+ isoWeek 插件） | ISO 周计算需与 Python `isocalendar` 对齐 | date-fns |
| 测试 | Vitest + Playwright + 对拍脚本 | 见 §11 | — |
| 部署 | 任意静态托管（GitHub Pages / 对象存储 / 自建 nginx） | 无后端，产物即 `dist/` | — |

**不引入的东西**：服务端、数据库服务、账号体系、分析埋点、第三方 CDN 上的运行时依赖（避免离线与隐私问题）、任何会把数据送出设备的能力（模型调用除外）。

---

## 4. 数据层设计

### 4.1 IndexedDB 对象存储

数据库名 `thin-muscle-plan`，用 Dexie `version(n).stores()` 管理。

| 对象存储 | 主键 | 索引 | 说明 | 进导出包 |
| --- | --- | --- | --- | --- |
| `days` | `date`（YYYY-MM-DD） | `date` | 每日记录的头部：体重、睡眠、精力、酸痛、备注、待办、汇总快照、`pendingCount` | ✅ |
| `intake` | `id`（uuid） | `date`, `meal`, `foodId`, `pending` | 摄入条目，一条 = 一个食材（DR-13） | ✅ |
| `workout` | `id`（uuid） | `date`, `exercise`, `type` | 训练条目，一条 = 一个动作（DR-20） | ✅ |
| `foods` | `id`（slug） | `name`, `nameNorm`, `category`, `source`, `disabled` | 食物库；`source ∈ {seed, llm, manual}` | ✅ |
| `reports` | `id`（uuid） | `type`, `periodStart`, `createdAt` | 周报 / 月报，含本地聚合数值与模型结论 | ✅ |
| `targets` | `'current'`（单例） | — | 热量与宏量目标、训练策略、每肌群组数下限 | ✅ |
| `calibrations` | `id` | `date` | 校准记录行（DR-32） | ✅ |
| `profile` | `'current'`（单例） | — | 档案与约束项、记录口径约定 | ✅ |
| `settings` | `'current'`（单例） | — | 单位、周起始日、外观、提醒、不再追问字段、`shareRecovery`（睡眠 / 精力 / 酸痛是否进指导请求，FR-1602） | ✅ |
| `snapshots` | `id` | `date`, `createdAt` | 本地快照，用于单日回滚（FR-1208） | ✅ |
| `pendingOps` | `id` | `kind`, `status`, `createdAt` | 待补全食物、待生成报告、失败重试（FR-1413 / FR-1504） | ✅（排队项随数据一起走） |
| `llmLogs` | `id` | `createdAt`, `taskId` | 调用日志与 token 估算（FR-1308 / FR-1414） | ❌ 可清空 |
| `modelConfig` | `'current'`（单例） | — | 接口地址、token、模型名等 | ❌ **绝不导出**（FR-1305） |
| `drafts` | `id`（uuid） | `date`, `status` | 自由文本 / 图片解析出的**草稿**：澄清没答完可以当天接着答；草稿不是数据，不参与当日汇总（DR-48 / §6.12） | ✅ |
| `adviceLog` | `id`（uuid） | `date`, `createdAt` | 每日指导（A 级，§6.4.2）：当日建议 + 依据 + 「采纳 / 不采纳」表态；**一天一条**，手动刷新覆盖当天那一条 | ✅ |
| `plans` | `id`（uuid） | `date`, `kind` | B 级生成式推荐的**当日缓存**（§6.2 / T3.8）：`kind ∈ {training, meal}`，一天一类一条，重新生成覆盖；内容里存的是**本地复核之后**的清单 | ✅ |

设计要点：

- **`intake` 与 `workout` 独立成表**，而不是嵌进 `days`：便于按日期、食物、动作做索引查询与统计，也避免单文档过大反复重写。
- **`days` 只存头部与派生快照**；汇总快照在每次写入后由 `domain/` 重算并覆盖，保证读取路径零计算。
- **食物引用用 `foodId`**，同时冗余一份 `foodSnapshot`（名称与六项数值），保证历史记录不会因后续修改食物库而变形（FR-904 / DR-02）。
- **单例表的导入**：`targets` / `profile` / `settings` 导入时按字段合并并保留本地记录口径约定，避免导入覆盖本机已声明的「不记」字段（FR-1103）。
- **索引键类型**：IndexedDB 只接受 string / number / Date / ArrayBuffer / Array 作索引键，布尔值不能作键。因此 `pendingFlag` / `disabledFlag` 等布尔语义字段统一用 0/1（`Flag`），否则条目会静默地不出现在索引查询结果里。

### 4.2 领域对象（TypeScript 契约）

```ts
type Meal = '早餐' | '午餐' | '晚餐' | '加餐';
type FoodSource = 'seed' | 'llm' | 'manual';
type Confidence = 'high' | 'medium' | 'low';

interface Food {
  id: string;                 // slug，如 '鸡蛋(全蛋 生)'
  name: string;
  // 归一化名：统一全半角括号、去空白、小写。**必须保留括号内容**——括号常承载区分信息
  // （鸡蛋(全蛋 生) vs 鸡蛋(水煮)、牛奶(全脂 市售) vs 牛奶(脱脂 市售)），去括号会让不同食物塌缩成同一 key
  nameNorm: string;
  category: string;           // 蛋奶 / 肉禽 / 主食 ...
  // 计量基准：数值一律表示「每个基准单位」。常见 '100g' / '100ml'，也存在按件的 '个'
  unit: FoodUnit;
  basisGrams?: number;        // 基准非 100g/100ml 时，单基准单位对应的克数；未知则留空
  kcal: number; proteinG: number; fatG: number; carbG: number;
  fiberG: number; sodiumMg: number;
  edibleNote?: string;        // 去壳可食部 / 生熟说明
  cookedState?: '生' | '熟' | '市售';
  portions?: PortionBasis[];  // [{ label: '1个', grams: 50 }]
  source: FoodSource;
  sourceNote?: string;        // 数值来源（FR-405 / DR-05）
  confidence?: Confidence;
  disabledFlag?: Flag;         // 0/1 代替布尔值，便于建索引
  createdAt: number; updatedAt: number;
}

interface IntakeEntry {
  id: string; date: string;
  meal: Meal; dish: string;             // 菜品/做法，同菜多食材共用
  foodId: string; foodSnapshot: { name: string; unit: '100g' | '100ml';
    kcal: number; proteinG: number; fatG: number; carbG: number; fiberG: number; sodiumMg: number };
  amount: { qty: number; unit: string; grams: number };  // 份量 + 折算克数
  computed: { kcal: number; proteinG: number; fatG: number; carbG: number; fiberG: number; sodiumMg: number };
  pendingFlag?: Flag;                   // 营养待补全（0/1）
  note?: string;                        // 估算假设
}

interface WorkoutEntry {
  id: string; date: string; time?: string;
  type: '力量' | '有氧' | '球类' | '拉伸' | '其他';
  minutes?: number; rpe?: number;
  muscles: string[]; exercise: string;
  sets?: { reps: number; weightKg?: number; bodyweight: boolean }[];  // 解析 4x8x60kg
  volumeLoad?: number;           // 组 × 次 × 重量，自重不计（DR-21）
  estimatedKcal?: number;        // 有氧：MET × 3.5 × 体重 / 200 × 时长（DR-22）
}

interface DayRecord {
  date: string; weekday: string;
  weightAmKg?: number; weightPmKg?: number;
  sleepHours?: number; energy?: number; soreness?: number;
  note?: string; todos?: { text: string; done: boolean }[];
  summarySnapshot?: DaySummary;   // 由 domain 计算后写入
  pendingCount: number;           // 待补全条目数（汇总据此标注不完整，FR-506）
}
```

**实现补充（2026-10-16，T4.4 已实现；同日下线「疑似重复」卡片）**：食物库治理落点
`application/foodAdmin.ts`（用例：概况 / 停用 / 删除保护）+ `pages/FoodsPage.vue`（`/foods`）。
下面几条是把 FR-408 / FR-411 / FR-412 落成代码时定的。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| FR-408 落在哪 | **只在新增那一刻**：写记录 / 入库时先按名称给出已有候选、提示「合并到它」而不是新加一条（`application/foodLibrary.ts` / `foodResolve.ts`，用例 `tests/food-resolve.spec.ts`） | 要拦的是「同一样东西被记了两遍」，那件事恰好发生在新增时；事后再从名字猜哪两条该合并，信息已经丢了一半 |
| 为什么下线「疑似重复」清单 | 2026-10-16 下线。静态分组按去括号主名成组（`looseFoodKey`），真实的 114 条种子里只有 5 组，其中 4 组是**设计上就该共存**的（`牛奶(全脂 市售)` / `牛奶(脱脂 市售)`、`肥牛卷(生)` / `肥牛卷(生 偏肥)`、`豆腐(北 老豆腐)` / `豆腐(南 嫩豆腐)`、两瓶啤酒），唯一「数值完全相同」的还是种子库有意留的那对 `鸡蛋(全蛋 生)` / `鸡蛋(水煮)`（备注写着「等同生蛋 便于直接记录」）——照它的建议「留一条、停用其余」会删掉用户真正要的那条 | 一个只说「可能是重复」却指不出该动哪条的清单，等于把判断推回给用户，还额外制造了误删的入口 |
| 名称工具的位置 | `baseNameOf` / `parenOf` 从 `application/foodLibrary.ts` 挪进 `domain/foodName.ts` | 纯字符串运算：治理页要用，但它们不属于「查库」 |
| 停用（`disabledFlag`）的语义 | 只让条目**不再出现在检索与新增候选里**（`listFoods` / `searchFoods` 过滤），数值与历史一字不动 | 摄入条目存的是 `foodSnapshot` 快照（DR-02），删/停都不该让历史记录变形 |
| 删除保护在哪一层 | 业务规则在 `application/foodAdmin.ts`（`deleteFood` 再查一次引用数），界面把按钮禁掉只是顺手 | 界面禁用绕得过去；「被引用的条目不可删除」是要能被单测钉住的规则 |
| 删除前为什么再查一次引用 | 从渲染列表到用户点确认之间可能又记了一条，用旧计数放行就会删掉正在被引用的条目 | 用户界面的读与写之间永远有时间差 |
| 引用计数怎么算 | 治理页一次 `intake` 全表扫描汇总（`tallyIntakeByFood`）；删除判据走 `foodId` 索引单查 | 上百条食物逐条 `count()` 会变成上百次查询；判据必须准 |
| 来源标签 | `seed` / `llm` / `manual` → 内置 / 模型 / 手工（`SOURCE_LABELS`），界面与导出用同一套字 | FR-411 要求三档可辨，字面统一免得两边各写一个 |

**实现补充（2026-10-16，FR-406 已实现）**：用户在 `/foods` 上就能覆盖模型给的数值。
落点 `domain/foodEdit.ts`（草稿解析与校验）+ `application/foodAdmin.ts` 的 `editFoodFacts`
（来源替换）+ `data/repositories/foods.ts` 的 `saveFood` + `/foods` 每行的「改数值」内联编辑器。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 谁优先 | 用户填的就是最终值。模型估算是**估算**，包装标签 / 厨房秤实测优先（DR-06） | 区间是给模型兜底的，不是用来否决一个拿着标签的人 |
| 越界怎么办 | **只提醒，不拦**：`reviewFactsEdit` 把越界项与宏量不自洽写进 `warnings`，界面显示、保存照旧 | FR-407 要的是「标出来让用户确认」，不是「禁止录入」；拦下去只会逼用户去别处凑数 |
| 缺项怎么办 | **六项都要填**，空着不算 0（「不知道」与 0 kcal 是两件事，DR-04），保存按钮直接禁用并指出缺哪项 | 0 顶替未知会让当日汇总悄悄少算一整条 |
| 来源怎么标 | 一律改成「手工」，`sourceNote` 写成「用户实测 / 包装标签 · 覆盖自模型：模型解析」；已是手工条目就只更新备注，不再套第二层「覆盖自」 | DR-06 要求两种数值可区分；嵌套来源会越改越长，反而读不出是谁给的 |
| 置信度 | 置空（`undefined`） | 置信度是模型对自己估算的说法（FR-405），数值换成实测之后它就不成立了 |
| 改哪几个字段 | 只动六项 + `source` / `sourceNote` / `updatedAt`：名称、分类、基准、停用标记、创建时间都不动 | 用户改的是「这条食物每 100g 是多少」，不是「这是哪条食物」 |
| 历史记录 | **不动**。摄入条目存的是当时的 `foodSnapshot` 快照（DR-02），改基准值不倒着改写已记的一餐；编辑器里也把这句话写给用户看 | 改了库就悄悄改掉三周前的汇总，是用户绝对预料不到的 |
| 没有改动 / 条目没了 | 都拒绝并说明原因（「六项数值和现在完全一样」「这条食物已经不在了」） | 空写入会刷新 `updatedAt`，让「最后动过」失去意义 |

**实现补充（2026-10-16，T3.8 第一步已实现）**：B 级生成式推荐（FR-801 ~ FR-808）重新立项后的**安全边界**。
落点 `domain/recommend.ts`（门禁与整理，纯函数）+ `pages/ProfilePage.vue` 的「饮食与训练约束」卡片 +
`pages/SettingsPage.vue` 的推荐开关卡片。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 为什么默认关 | 默认关（`defaultSettings()` 写 `false`，老数据没有这个键也读成关），必须用户显式打开 | 它会把「今天吃什么」写成具体清单，也就可能推荐出用户不能吃的东西；这种功能不该默认替人打开 |
| 开启的前提 | **四项约束齐了才能打开**：忌口 / 过敏 / 可用器材 / 每餐时间（`missingRecommendConstraints`）。没齐时开关禁用，并列出缺哪几项 + 去档案页的入口 | FR-1003 写的是「否则不得开启」—— 界面禁用只是顺手，真正跑推荐的应用层还会再判一次 |
| 「无」不是留空 | 没有忌口 / 过敏就填「无」；只填空白字符不算填，`0` 不算填（DR-04） | 留空分不清「没有」与「还没填」，而这两者对应的动作正相反：前者随便做，后者先别做 |
| 为什么要器材与每餐时间 | 训练推荐拿它做替代动作，食谱拿它决定能不能做（只有一口锅 vs 有烤箱）；每餐时间约束方案的复杂度 | 这是长期事实（FR-1002），不靠问「家里还有什么」（FR-803） |
| 约束怎么进输入 | 拆分认换行 / 逗号 / 顿号 / 分号（`parseConstraintList`）；拼成给模型的行时缺项写「未填」而不是省略 | 用户怎么写都得认；省略会让模型以为「没有约束」 |
| 存在哪 | 四项在 `profile`（长期事实），开关是 `settings.recommendEnabled`；两处都进了导出包与导入的合并白名单 | 「人是什么样」与「这次要不要用」分开存；导出 / 导入两边都不能丢 |
| 导出 | `profile.md` 多一节「饮食与训练约束」（填了才写），front-matter 的键名不动 | 脚本读的键名不能改；正文给人看，机器读的那份在导出包里 |

**实现补充（2026-10-16，T3.8 第二步已实现）**：两个推荐任务与 `/plan` 页。
落点 `domain/plan.ts`（本地复核 / 复算，纯函数）+ `domain/training.ts` 的两段聚合（`muscleRecency` /
`recentExerciseLoads`）+ `llm/tasks/plan.ts`（契约）+ `application/plan.ts`（用例 + 门禁 + 缓存）+
`data/repositories/plans.ts`（`plans` 表）+ `pages/PlanPage.vue`（`/plan`）。契约见 §6.5 / §6.6。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 门禁在哪一层 | **应用层再判一次**（`gateMessage`）：开关没开、四项约束没齐都直接返回失败，一次模型都不调用；界面禁用按钮只是顺手 | FR-1003 写的是「否则不得开启」；界面绕得过去，单测要能钉住「门禁真的拦住了」 |
| 门禁的两条一起说 | 开关没开 + 约束没齐时，两条原因拼接输出，不提前 return | 两件事都要做，一次说清省得用户跑两趟 |
| 落库的是**复核之后**的清单 | `reviewTrainingPlan` / `recomputeMealPlan` 在 `putPlan` 之前跑；被剔除的动作、按库重算的数值一起进记录 | 否则界面看到的是模型原文，而 FR-806 要的恰恰是「展示的一定是本地算的那一份」 |
| 器材怎么核 | 动作要**自己申报** `equipment`（契约里新增的字段）；本地做双向包含匹配（「哑铃」对上「一对哑铃（可调）」）；申报的器材**一个都不在**档案里就剔除整个动作并写进 `notices` | 模型不申报就只能猜动作要什么器材；「你根本没有这件器材」是必须剔除的，做成提示等于让它留在清单里等着被照做 |
| 没申报器材的动作 | 留着，但打上 `equipmentNote`「没标器材，本地核不了」 | 剔除它比留着更糟（可能删掉一个自重动作）；但也不能装作核过了 |
| 加重提示 | `weightKg` 超过**上次同动作**的 +10% 就写 `weightNote`，**不拦**；参照表按动作名归一化后索引，取近 14 天内最近一次 | FR-801 要「给具体加重」，加多少是用户的决定；但 +10% 以上值得让他先看一眼 |
| 时长由本地算 | `总组数 × 3 分钟 + 8 分钟热身`（`MINUTES_PER_SET` / `WARMUP_MINUTES`）；模型的 `estimatedMinutes` 只在偏差 >25% 时进 `notices` | 时长是数，是数就得本地算（DR-45）；但排组的松紧有个人差异，所以按组数估而不是编一个精确值 |
| 恢复窗口 | `hoursSinceLast < 48` 的肌群进 `needsRecovery`（发给模型）与 `recentMuscles`（提示）；按**天粒度 × 24** 算 | 记录里没有可靠的时刻；按天算的 48 小时等于「今天 + 昨天」，比假装精确更诚实 |
| 食谱的合计 | 逐行按食物库 `factsForGrams` 算，命中不了的行**不进合计**并写进 `missing`；`totalsPreview` 只留痕比对（偏差 >15% 提示） | 宁少不臆造：显示出来的每一行都要能在库里指出来源，否则「本地复算」就是摆设 |
| 食材名怎么匹配 | 三级：归一化相等 → 去括号主名相等 → 主名互为前缀且**唯一**；库里同时有 `鸡蛋(全蛋 生)` 与 `鸡蛋(水煮)` 时「鸡蛋」不认 | 猜错的数值比空着更糟（与 `matchFood` 的注释同一条理由） |
| 停用的食物 | 不进候选（`buildFoodIndex` 跳过 `disabledFlag === 1`） | 停用是用户明说「别再用它算菜」（T4.4） |
| 常用食材名 | 近 14 天记过的按次数取前 20；没有历史时用库里蛋白 ≥10g/100g 的前 20 条兜底；**只给名称** | FR-805 要求输入是本地摘要；给名称是为了让模型挑库里有的东西，不必把数值发过去 |
| 与缺口的对比 | `compareWithGap` 本地算（热量 / 蛋白 / 钠 / 纤维），热量留 50 kcal 余量再判「超了」 | FR-802 的「与缺口对比」是本地的减法；按克数复算本来有几 kcal 零头，卡死会天天报超 |
| 缓存 | 指纹 = 输入（`fingerprintOf`，与每日指导同一份实现）；同日同类指纹没变就复用，`force` 才重新调用 | 推荐是高频入口，每次都花钱受不了（FR-1409 / §6.2 的「当日缓存」） |
| 一天一条 | 重新生成**覆盖**当天那一条（`getPlan` 取最新、`putPlan` 复用原 id） | 与每日指导一致；报告那种「留历史版本」会让「今天看哪一条」变含糊 |
| 模型失败 | 不落库、不覆盖已有那一版 | 推荐是照着做的清单，写进去一条错的比没有更糟 |
| 伤病约束 | **契约里有、本轮没有来源**：档案在 2026-10-16 的瘦身里下线了 `injuries`，FR-1003 只要求恢复四项，所以输入里不含伤病；提示词里改成「用户没说不适就按普通计划」 | 不编一个字段出来；这一条是已知缺口，补它要先改档案与 FR-1003，不能只在提示词里假装有 |

### 4.3 版本与迁移

当前版本 **v4**：v1 是初始表结构；v2 新增 `drafts`（草稿）；v3 新增 `adviceLog`（每日指导，§6.4.2）；v4 新增 `plans`（推荐当日缓存，T3.8）。
既有存储与数据原样保留。增量的写法是「每个版本只声明这一版新增的那张表」，Dexie 会沿用上一版已声明的存储：

```ts
this.version(1).stores({ /* 全部初始表 */ })
this.version(2).stores({ drafts: 'id, date, status' })   // 其余表沿用 v1
this.version(3).stores({ adviceLog: 'id, date, createdAt' })  // 其余表沿用 v2
this.version(4).stores({ plans: 'id, date, kind' })  // 其余表沿用 v3（B 级推荐当日缓存，T3.8）
```

**反例（2026-10-16 真踩到）**：把第一行写成 `this.version(3).stores({ /* 全部表 + 新表 */ })`，
再保留 `this.version(2).stores({ drafts })`，Dexie 会把它读成「v2 里只有 `drafts` 一张表」——
1 → 2 的升级会把其余存储全部删掉，老用户的数据当场蒸发。`app/tests/db.spec.ts` 的 v1 → 最新版迁移用例
就是为这条写的：**先声明 v1 的全量表，再加增量版本**。

- Dexie 的 `version(n).stores(...).upgrade(tx => ...)` 处理结构变更；每次变更必须同时提供 `upgrade` 与「导出包兼容说明」。
- 迁移必须在**应用启动、进入界面之前**完成；迁移中显示阻塞式进度，禁止用户中途关闭（避免半迁移状态）。
- 迁移前自动写一次快照（`snapshots`），失败可回滚。
- 迁移代码必须可单测：用上一版的样例数据构造 fixture，断言迁移后数据完整。

**实现补充（2026-10-16，T4.3 已实现）**：`snapshots` 表的用法定成「安全网」，不是「版本管理」。
落点 `data/repositories/snapshots.ts`（存取 + 上限）、`io/snapshot.ts`（载荷格式与校验）、
`application/snapshot.ts`（自动快照与回滚编排）。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 快照拍什么 | 只拍**一天**：头部 + 摄入 + 训练 | 「某一天被写坏了」是真正会发生的场景；全库快照又大又和 §7.1 的导出包重复 |
| 什么时候拍 | 破坏性写操作**之前**：删单条记录、导入覆盖 / 合并（只拍真会被改的日期）、回滚之前 | 事后再拍等于没拍 |
| 内容没变时 | **不重复写**（`snapshotContentKey` 比内容，不比 JSON 文本） | 载荷里带 `takenAt`，比文本永远去不掉重；同一副安全网留一百份没有意义 |
| 上限 | 只保留最近 100 条（`SNAPSHOT_KEEP`，写入后顺手 `pruneSnapshots`） | 不承诺「永远留着」，也不会把配额吃满 |
| 载荷格式 | 本应用自己的 JSON，领域对象原样存；读回来走**手工结构检查** | 用 Zod 会剥掉 schema 之外的键 → 回滚时静默丢字段（与 §7.1 同一条理由） |
| 回滚语义 | 整天替换（先删这一天三张表再写回）放在**一个事务**里，之后按本地口径重算汇总 | 删了旧的没写回新的，比不回滚更糟 |
| 回滚本身 | 动手前先给「当前状态」拍一张，所以误点了还能滚回来 | 回滚是用户手滑最可能发生的入口 |
| 坏快照 | 整条拒绝并说清哪里坏了，**一个字节都不改**（连「回滚前的备份」都不拍） | 宁可不动，也不写半份数据 |

验收：`tests/snapshot.spec.ts`（内容去重 / 整天还原 / 回滚可再回滚 / 坏快照拒绝 / 保留上限 /
导入前自动快照）与 `tests/data-page.spec.ts` 的快照卡片用例。

> 本节原文的「**迁移前**自动写一次快照」还没做：现有 v1 → v3 迁移只是加表、不改写已有数据，
> 没有值得回滚的中间态。等出现真正改写数据的迁移时，这里要一起补上（接口已经就位：
> `captureDay(date, reason)` 换个 reason 即可）。

### 4.4 持久化与配额

- 启动时请求持久化存储：`navigator.storage.persist()`；被拒绝时在数据页提示「浏览器可能在空间紧张时清理数据，请定期导出」。
- 数据页展示 `navigator.storage.estimate()` 的用量。
- **不把业务数据放 localStorage / sessionStorage**（TD-08）；localStorage 只允许存 UI 偏好（如上次停留的 tab）。
- iOS 上的已知风险：长期不打开的 PWA 其站点数据可能被回收 → 对策是首启引导 + 定期导出提醒（见 §9.4）。

---

## 5. 计算引擎（domain 层）

### 5.1 模块划分

| 模块 | 职责 | 对应脚本命令 |
| --- | --- | --- |
| `domain/portion.ts` | 份量 → 克的折算（g/ml/个/只/碗/勺/盒），返回依据字符串 | `lookup --g` |
| `domain/nutrition.ts` | 单条记录的营养计算、当日求和 | `totals` |
| `domain/targets.ts` | 目标对比、差额、占比、缺口提示文案 | `totals` |
| `domain/trend.ts` | 区间聚合（日表、体重变化率、达标率、训练明细、TDEE 输入） | `trend` |
| `domain/training.ts` | 组次重量解析、容量负荷、MET 消耗、肌群组数 | `trend` 训练部分 |
| `domain/weight.ts` | 晨重序列、7 日均线、夜间净流失、变化率 | `trend` 体重部分 |
| `domain/adherence.ts` | 达标率（热量 ±10%、蛋白 ≥ 目标×90%） | `trend` |
| `domain/format.ts` | 数值格式化（与脚本 `fmt` / `fmt_signed` 对齐，整数不带小数点、非整数 1 位小数） | 显示与导出 |
| `domain/tdee.ts` | Theil-Sen 斜率反推 TDEE、样本门槛判断 | `tdee` |
| `domain/calibration.ts` | BMR（Mifflin-St Jeor）→ TDEE → 阶段目标、校准幅度约束 | `init` |
| `domain/reportDigest.ts` | 报告用本地摘要（区间聚合，模型输入） | 新增（脚本无此能力） |
| `domain/validate.ts` | 格式与数值校验，产出「行号 + 字段 + 原因」清单 | `check` |

所有模块为**纯函数**：输入领域对象，输出数据，无 IO、无 `Date.now()` 直接依赖（时间由调用方传入）。

### 5.2 对齐 `nutrition.py` 的算法清单

| 项 | 口径（必须与脚本一致） |
| --- | --- |
| 汇总 | 六项求和；钠与上限比较；占比 = 摄入 / 目标（钠为 摄入 / 上限） |
| 均线 | 以**晨重**为序列，窗口默认 7 天，缺失日不补零 |
| 夜间净流失 | 当天晨重 − 前一天睡前重；两者缺一即留空（DR-08） |
| 体重变化率 | 区间首末有效晨重之差 / 首值 / 天数 × 7（周化），与脚本 `trend` 一致 |
| 达标率 | 热量：\|摄入−目标\| ≤ 目标×10%；蛋白：摄入 ≥ 目标×90%；分母为「有记录天数」 |
| 容量负荷 | Σ(组 × 次 × 重量)，自重动作计 0（DR-21） |
| 有氧消耗 | `MET × 3.5 × 体重(kg) / 200 × 时长(min)`，体重取当日晨重，缺失则取最近有效晨重，再缺失则留空并提示 |
| TDEE 反推 | Theil-Sen 稳健斜率 × 每日平均摄入；样本门槛 ≥14 天（至少 7 天）有效配对（DR-27） |
| 启动目标 | Mifflin-St Jeor → 活动系数 → 阶段调整；蛋白 2.0 g/kg、脂肪 0.8 g/kg、碳水补足余量 |
| 兼容字段 | 无晨重时用 `weight_kg` 兜底并标记口径不明（DR-10） |
| 显示数值舍入 | 1 位小数且**逢半取偶**（对齐 Python `'%.1f'`）；整数不带小数点，缺失写 `-` |

> 舍入这一条 2026-10-16 才真正对齐：JS 的 `toFixed` 是逢半进位，`7.25` 会给 `7.3`，
> 而 Python 给 `7.2` —— 0.25 的倍数正是**均值**最常撞上的数字（如 4 条记录的 RPE 均值 29/4）。
> 导出的 AUTO 区块要求与脚本逐字一致，差一位小数就会让对拍随机失败。
> 实现见 `domain/format.ts` 的 `fmtNumber`（展开成 20 位小数再按十进制取偶，别直接乘 10 取整）。

### 5.3 与脚本对拍（核心质量手段）

`scripts/nutrition.py` 是**验收基准**（需求 §3.3）。做法：

1. 测试 fixture：`app/tests/fixtures/` 里的 `records/2026-10-09.md` ~ `2026-10-13.md`、`profile.md`、
   `targets.md` 是**合成数据**（2026-10-15 起本仓库不含任何真实记录），覆盖同样的结构边界：
   一天没称重、一天只有睡前重、一天训练、油盐单独成行。
2. 用现有脚本产出期望值：`npm run expected`（`app/scripts/gen-expected.mjs`）。它把
   `scripts/nutrition.py`、`data/foods.csv` 与 fixtures 组装进一个**系统临时工作区**再调用脚本，
   生成 `expected-totals.txt` / `expected-trend.txt` / `expected-tdee.txt` / `expected-init.txt`；
   另造 21 天合成记录跑一次 `tdee`，得到 `expected-tdee-synthetic.txt`
   （fixtures 里只有 3 天同时有体重与摄入，`tdee` 只能给出「数据不足」，覆盖不到反推算法本身）。
3. Vitest 中：导入 fixture → 跑 `io/markdown` 解析 → 跑 `domain/` 计算 → 与期望值**逐项比对**。
4. 容差取 `0.051` 而不是设计初稿的 `0.05`：期望值来自脚本的**显示输出**（已按 1 位小数四舍五入），
   所以天然带有半个最低位的舍入误差。空值必须同为缺失，不允许「一边是 0 一边是 -」。
5. 对拍范围覆盖：汇总六项与占比与提示文案、逐日体重均线 / 夜间净流失、体重变化率、达标率、
   训练组数与容量负荷与动作明细、TDEE（真实样本门槛 + 合成样本算法）、首次估算（`init`）。

这条测试同时验证了三件事：IndexedDB 落库前的解析正确、计算口径未漂移、导出可被原脚本消费。

**已知且有意保留的差异**：`nutrition.py init` 只认记录 front-matter 里的旧字段 `weight_kg`，
所以几乎总是退回 `profile.md` 的体重；应用里以「最近一次真实称重」为准（`domain/calibration.ts`
的 `resolveSeedWeight`：最近晨重 → 最近睡前重 → `profile.md`）。对拍测试显式传入脚本所用的体重，
让这条差异被写在测试里而不是被隐藏。
---

## 6. 大模型集成设计

### 6.1 客户端与协议

只支持 OpenAI 兼容的 Chat Completions：

```
POST {baseUrl}/chat/completions
Headers: { Authorization: Bearer {token}, Content-Type: application/json }
Body: {
  model, messages: [{ role: 'system', content }, { role: 'user', content }],
  temperature: 0.2, max_tokens: <任务上限>,
  response_format: { type: 'json_object' }   // 优先尝试，失败则降级
}
```

| 设计点 | 处理 |
| --- | --- |
| `baseUrl` 归一化 | 用户可能填 `https://host/v1` 或 `https://host/v1/chat/completions`；统一归一为前者后拼接 |
| `response_format` 兼容性 | 先带该参数请求；若返回 400 且错误信息提示不支持该参数，则去掉后重试一次并记入配置备忘录，后续请求不再带 |
| `temperature` | 固定 0.2，配置项不可改（结构化输出需要稳定） |
| 超时 | 默认 60s，可在设置调整；超时计入失败与重试 |
| 流式 | 不使用流式；结构化短输出用不上，反而增加解析复杂度 |
| 重试 | 仅对网络错误、超时、429、5xx 自动重试 1 次，指数退避（1s → 2s） |
| 并发 | 同时最多 1 个在途请求（避免批量补全打爆配额，FR-1310） |
| 凭据安全 | token 只存 `modelConfig`；不写日志、不进导出包、不在错误提示中回显（FR-1305 / NFR-11） |

### 6.2 任务注册表

每个模型任务是注册表里的一条声明，`llm/tasks/<taskId>.ts` 导出：

```ts
interface LlmTask<In, Out> {
  id: string;                 // 'food.resolve'
  version: number;            // 契约版本，写入日志
  systemPrompt: string;       // 固定且短
  buildPayload(input: In): unknown;    // 只放必需字段（DR-40）
  schema: ZodSchema<Out>;     // 输出契约
  inputBudget: number;        // 输入预算（FR-1413 的目标值），预算告警用
  maxOutputTokens: number;    // 输出上限；两者都可写成「按输入规模缩放」的函数
  cache?: (input: In, out: Out) => void; // 落库缓存（如食物库）
}
```

首批任务：

| taskId | 用途 | 触发 | 缓存 |
| --- | --- | --- | --- |
| `food.resolve` | 解析库中不存在的食物营养 | 用户确认后（FR-403） | 落 `foods`（FR-404） |
| `report.weekly` | 周报结论与建议 | 用户点生成（FR-701） | 不缓存，可重新生成 |
| `report.monthly` | 月报结论与建议 | 用户点生成（FR-702） | 不缓存 |
| `plan.training` | 今天练什么（FR-801，T3.8） | 用户点「今天练什么」 | 当日缓存（`plans`，一天一条） |
| `plan.meal` | 今天还能吃什么（FR-802，T3.8） | 用户点「今天吃什么」 | 当日缓存（`plans`，一天一条） |
| `calibration.review` | 校准建议 | 报告页内（FR-907） | 不缓存 |
| `log.parse` | 自由文本 → 摄入 / 训练草稿 | 用户提交一段描述（FR-110 / FR-208） | 不缓存（同一文本 5 分钟内去重） |
| `log.parse.vision` | 图片 + 文字 → 摄入草稿 | 用户提交图片（FR-111） | 不缓存（图片不落库） |

### 6.3 契约一：`food.resolve`

**输入（本地构造，不含历史）**

```json
{ "items": [ { "text": "凯撒沙拉(市售 预包装)", "portionHint": "330g" } ] }
```

合并规则：一次最多 10 条，超出分批；同一输入在 `foods` 已存在（含别名）则不进入请求（FR-1408）。

**输出契约**

```json
{
  "items": [{
    "query": "凯撒沙拉(市售 预包装)",
    "matched": true,
    "name": "凯撒沙拉(市售)",
    "category": "沙拉",
    "unit": "100g",
    "kcal": 100.1,
    "protein_g": 7.0,
    "fat_g": 5.3,
    "carb_g": 6.1,
    "fiber_g": 0,
    "sodium_mg": 285,
    "cooked_state": "市售",
    "edible_note": "按包装标签",
    "portions": [{ "label": "1盒", "grams": 330 }],
    "source_note": "依据包装标签换算",
    "confidence": "high"
  }]
}
```

**校验规则（本地，`Zod` + 业务校验）**

| 规则 | 处理 |
| --- | --- |
| `matched=false` | 不落库，向用户提示「模型无法确认该食物，请手工录入」 |
| 六项数值范围 | kcal 0~900、蛋白 0~100、脂肪 0~100、碳水 0~100、纤维 0~100、钠 0~5000（每 100g/ml）；越界标为可疑并要求确认（FR-407） |
| 宏量自洽 | 4×蛋白 + 9×脂肪 + 4×碳水 与 kcal 的偏差同时超过「相对 35%」与「绝对 25 kcal」时标为可疑（纤维与 Atwater 系数差异会带来几 kcal 的常量偏差，单一相对阈值会误报） |
| 酒精豁免 | 名称命中 啤酒 / 白酒 / 红酒 / 葡萄酒 / 米酒 / 清酒 等时跳过宏量自洽检查：乙醇 7 kcal/g 不进宏量，反算必然偏低 |
| 名称去重 | 先按 `nameNorm`（保留括号）精确命中，再按包含关系给出近似候选；命中则提示合并而非新增（FR-408） |
| 置信度 | `low` 时必须用户确认后才参与汇总（FR-405） |

> 六项范围的**定义只有一份**：`domain/nutrientRange.ts` 的 `NUTRIENT_RANGES` / `rangeChecks`。
> 模型返回的数值（本表）与用户手改的数值（FR-406，见 §4.2 的「实现补充」）走同一份区间，
> 免得出现「模型填 6000 mg 钠要确认、用户手填 6000 却放行」这种两套标准。

### 6.4 契约二：`report.weekly` / `report.monthly`

两个任务共用同一套契约（`type` 区分），月报只是区间更长、多一段「与上月对比」。**输入是 `domain/reportDigest.ts` 产出的紧凑摘要，不含任何原始记录。**

**输入（周报示例，约 400-600 tokens）**

```json
{
  "period": { "type": "weekly", "label": "2026-W41", "start": "2026-10-05", "end": "2026-10-11", "days": 7 },
  "coverage": { "daysWithIntake": 2, "daysWithWeight": 1, "ratio": 0.29 },
  "intake": { "avgKcal": 1893.6, "target": 2240, "avgProteinG": 88.7, "proteinTargetG": 150,
              "kcalHitDays": 0, "proteinHitDays": 0, "recordedDays": 2 },
  "weight": { "amSeries": [{ "date": "2026-10-11", "kg": 75.6 }], "ma7": 75.6,
              "changeKg": null, "changePctPerWeek": null },
  "training": { "days": 1, "minutes": 45, "sets": 12, "volumeLoadKg": 180,
                "byMuscle": [{ "muscle": "二头", "sets": 6 }, { "muscle": "三头", "sets": 6 }],
                "targetDays": 3, "targetSetsPerMuscle": 10 },
  "currentTargets": { "kcalTarget": 2240, "proteinTargetG": 150, "lastCalibrated": "2026-10-10" },
  "previousDigest": { "period": "2026-W40", "conclusion": "…（上一期结论文本，限 200 字）" }
}
```

**输出契约**

```json
{
  "summary": "一句话概括本期。",
  "training": { "assessment": "未达标/达标/超预期", "notes": ["…"] },
  "diet": { "assessment": "…", "notes": ["…"] },
  "recovery": { "notes": ["…"] },
  "findings": [
    { "kind": "fact", "text": "…" },
    { "kind": "inference", "text": "…" }
  ],
  "issues": ["…"],
  "actions": ["…"],
  "calibration": { "recommended": false, "deltaKcal": 0, "rationale": "…" },
  "disclaimer": "…"
}
```

**本地处理**

| 步骤 | 处理 |
| --- | --- |
| 覆盖率门禁 | `coverage.ratio < 0.5` 时在报告顶部强制显示「样本不足，结论仅供方向参考」，并禁止 `calibration.recommended=true`（FR-708 / FR-707） |
| 数值守卫 | 从 `summary / notes / findings / issues / actions / rationale` 中提取数字 token，凡不在「输入摘要数字白名单 + 允许的派生常量（周数、天数、百分比形式）」中，标记为「待核对」并在 UI 高亮（DR-37） |
| 校准门禁 | `calibration.recommended=true` 且 `\|deltaKcal\| > 150` 时，直接改写为待确认项并提示约束（FR-904） |
| 事实/推断 | `findings[].kind` 必须存在，缺失则整份报告判为不合规，走重试（FR-706） |
| 落库 | 数值部分存本地聚合结果，文字部分存模型输出，并记录 `model`, `taskVersion`, `createdAt`, `editedByUser=false`（FR-710） |

**实现补充（2026-10-15）**：三处把上面的规则落成口径，交接时不要改回去。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 覆盖率分母 | `coverage.ratio = 有饮食记录的天数 / 区间天数` | 分母必须是区间本身：调用方若只传有记录的天，覆盖率会被算成 100% |
| TDEE 进摘要的条件 | `tdee` 只在样本 ≥ 7 天（`MIN_TDEE_POINTS`）时写入 | 3 天数据也能反推出一个「数」，写进摘要就等于给了模型一个可以引用的假事实 |
| 百分比放行 | 数字守卫放行 `0-100` 的整数**仅当它带 `%`** | 若放行「任意小整数」，`78 kg` 这类编造体重会被漏掉 |

#### 6.4.1 摘要 v2（2026-10-16 定，**已实现**）

> 落点：`domain/reportDigest.ts`（聚合）+ `domain/types.ts` 的 `ReportDigest`（契约）+
> `application/report.ts` 的 `buildDigest()`（数据组装，逐日带上睡眠 / 精力 / 酸痛）。
> 上面 §6.4 的示例 JSON 是 v1；**字段以本节与 `ReportDigest` 类型为准**。
> 实现时收窄了三处，都是有意的：① 睡眠只统计"<6 小时"这一档（睡太久不需要建议）；
> ② RPE 只给均值与"≥8 的条目数"，不给逐条；③ 钠 / 纤维的达标判定直接沿用
> `domain/targets.ts` 缺口提示的既有口径（钠超上限、纤维 ≥ 目标），**不另立阈值**。

**为什么现在要记这一笔**：输出契约里有 `recovery.notes`，但输入摘要里**没有任何恢复类数据** ——
模型被要求"谈谈恢复"，手里却一个数都没有。同理，训练块只有容量负荷与分钟（没有强度/有氧），
饮食块只有热量与蛋白（没有钠/纤维）。这些都是**已经采集、但没有喂进摘要**的数据。

**要加进摘要的（保留现有字段，只做加法）**

| 块 | 新增 | 来源 | 形式与口径 |
| --- | --- | --- | --- |
| `recovery`（新增块） | 睡眠 | `DayRecord.sleepHours` | 平均值 + 分布（<6 / 6-8 / >8 的天数）+ **有记录天数** |
| `recovery` | 精力 / 酸痛 | `DayRecord.energy` / `soreness`（1-5 星） | 分布（≥4 的天数、≤2 的天数）+ 有记录天数；不追求"平均 3.4"这种伪精确 |
| `training` | RPE | `TrainingAggregate.rpe`（已有，未进摘要） | 平均 + 分布（≥8 的天数） |
| `training` | 有氧消耗 | `TrainingAggregate.burn`（已有） | 区间合计 kcal |
| `intake` | 钠 / 纤维 | 现有 `buildSummaryRows` 的口径 | 摄入均值、上限/目标、达标天数 |
| `previousDigest` | 上一期的**数字** | 上一份 `ReportRecord.digest` | 至少 `avgKcal` / 体重变化 / 训练天数与容量 / 达标天数；现在只有一段结论文本，"比上期"只能靠模型随口说、守卫也核对不了 |

**工程上的三点便利 / 纪律**

1. **数字守卫不用改**：白名单是从 `digest` 递归收集的（`buildNumberWhitelist`），新增数值字段自动纳入。
2. **聚合放 `domain/reportDigest.ts`**（纯函数、可测）；数据组装在 `application/report.ts` 的
   `buildDigest()`，它本来就逐日读了 `days` 表，加三个字段即可。新增 `sleepHours/energy/soreness`
   需要在 `TrendDayInput` 或摘要专用输入里带上它们。
3. **口径纪律**：睡眠/精力/酸痛是**自报且稀疏**的数据，摘要必须带"有记录天数"，
   否则模型会把 3 天样本当成一整期（现有 `coverage` 就是这个思路）；**不要自造"睡眠达标线"**，
   除非使用者在目标里自己定一条；主观评分给分布而不是单值。

**明确不进摘要（保留字段，但报告用不上，别硬塞）**

| 字段 | 为什么不进 |
| --- | --- |
| `profile.bodyFatPct` | 长期单值，体脂秤误差 ±3~5%，进区间趋势会误导；只可能作为背景单值 |
| `profile.trainingYears` | 粗档「训练水平（新手/中级/高级）」已足够，年限不改变任何本地计算 |
| `profile.wakeTime` / `sleepTime` | 报告不需要；它只对"提醒时间"有意义，而提醒按 TD-09 只做应用内 |
| 记录文件的 `## 待办` | 是原工作流的事项清单，不是身体/训练数据；送进摘要只会变成噪声，PWA 里也没有编辑入口 |
| `DayRecord.note` / 草稿 `rawText` | 自由文本原文：隐私与 token 双重成本。要用就做成显式的「这次带上我的备注」 |
| `Food.disabledFlag`、`SettingsRecord.reminders/theme/units` | 分别属食物库治理（T4.4）与设置页（T4.6），与报告无关；只有 `weekStart` 与"周报口径"沾边，现在写死周一 |

#### 6.4.2 契约七：`coach.daily`（A 级指导，P0）

**目标**：把"周报式的指导"变成"当天就能用的指导"。输出**不是**食谱或动作清单（那是 B 级、默认关的
`plan.*`），而是基于本地摘要的诊断与下一步动作。

**输入**（= 摘要 v2 + 当日缺口，仍然不含任何原始记录）

```json
{
  "date": "2026-10-16",
  "digest": { "...": "§6.4.1 的摘要 v2（近 7 天滚动窗口）" },
  "today": { "kcalSoFar": 1120, "proteinSoFarG": 68, "remainingKcal": 1120, "remainingProteinG": 82,
             "pendingItems": 2, "trainedToday": false, "weightAmKg": 75.1 },
  "history": { "advice": [{ "date": "2026-10-14", "text": "把蛋白补到 150 g", "adopted": true }] }
}
```

**输出契约**

```json
{
  "headline": "一句话结论",
  "advice": [
    { "kind": "fact", "text": "近 3 天蛋白都没到 120 g", "basis": ["recovery.energyDays", "intake.avgProteinG"] }
  ],
  "focus": ["今天要做的 1-3 件事，按优先级"],
  "ask": ["还缺的信息，例如今天还练不练"],
  "disclaimer": "…"
}
```

**本地处理（与报告同一套闸门）**

| 步骤 | 处理 |
| --- | --- |
| 依据校验 | 每条 advice 的 `basis` 必须命中摘要 / 当日缺口里真实存在的字段；命中不了就整条**不展示**（NFR-13） |
| 数字守卫 | 沿用 §6.4 的规则：正文数字必须在白名单里（白名单含摘要 v2 + 当日缺口数字） |
| 样本门禁 | 摘要覆盖率 < 50% 时，`headline` 前强制加"样本不足"，且不出"调整目标"类建议 |
| 频率与缓存 | 同一天默认只生成一次（`meta` 里记日期 + 摘要指纹）；数据变了或用户手动刷新才重新调用 |
| 落库 | 建议连同 `basis`、模型、时间写进 `adviceLog`；用户可标记"采纳 / 不采纳"，供下一期 `history.advice` 使用 |

**明确不做（这一版）**：不生成食谱、不排训练计划、不开采购清单 —— 那些是 B 级（`plan.meal` / `plan.training`，
默认关，见需求 M8 的第二级）。A 级只说"该往哪使劲"，把"具体怎么吃/怎么练"留给用户或 B 级开关。

**实现补充（2026-10-16，已实现）**：落点 `llm/tasks/coach.ts`（契约）+ `domain/coach.ts`（本地闸门）+
`application/coach.ts`（拼输入 / 落库）+ `pages/CoachPage.vue`（`/coach`）+ `adviceLog` 表（schema v3）。
下面几处是把契约落成口径时定的，交接时不要改回去。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 依据要「有值」才算命中 | `resolveBasisPath` 要求路径存在**且值不是 `undefined`**；摘要里空值一律留空（不是 0），所以 `tdee.value` 在样本 < 7 天时命不中 | NFR-13 要的是「真实存在的字段」；把「没记录」当成可引用的 0 会让编造的建议合法化 |
| 没有目标就不给「还差多少」 | `today.remainingKcal` / `remainingProteinG` 在目标缺失时**留空**，不补 0 | 没有目标时「还差 1600 kcal」是假事实，模型会当真引用 |
| 样本门禁的落地形式 | 覆盖率 < 50% 时：`headline` 前缀「样本不足：」，并去掉 `basis` 落在 `currentTargets.` / `tdee.` 的建议 | 契约只说「不出调整目标类建议」，这里把它落成可判定的依据前缀，而不是去猜文案里有没有「目标」两字 |
| 「今天练了」的口径 | 当天有训练记录且**不全是拉伸**才算 `trainedToday=true` | 与训练容量的口径一致（拉伸不计容量），否则"今天别加量"这类判断会被拉伸记录误触发 |
| 缓存与版本 | 一天一条，`fingerprint` = 摘要 + 当日缺口的稳定哈希；数据没变就不调用模型，手动刷新**覆盖**当天那一条 | 指导是高频调用（FR-1409）；过期指导留在列表里只会让"今天看哪一条"变得含糊（与报告的保留历史版本不同，那边是复盘材料） |
| `history.advice` 的取法 | 只带**表过态**（采纳 / 不采纳）的条目，同一句留最近一次，最多 5 条，且**不含今天自己那一条** | 没表态的没有信息量（NFR-14）；把今天的表态算进去会让「点一下采纳」就把今天的指纹弄脏、页面立刻提示「数据有更新」 |
| FR-1602 的三项开关 | 落在 `settings.shareRecovery`（缺省全开，老数据不因此丢字段）；关掉的项**连聚合都不参与**（`sleepDays` 归零、`avgSleepHours` 消失），并计入指纹 | 关掉就该在请求里彻底看不见，而不是"发过去但请你别看"（FR-1601 / FR-1602） |
| 模型失败 | **不写任何指导**，界面改用本地缺口提示兜底（`domain/targets.ts` 的 `buildHints`） | 指导没有"数值区"这种本地保底内容可存（§9.3 降级矩阵） |

### 6.5 契约三：`plan.training`

> **2026-10-16 状态**：B 级生成式推荐（T3.8）**已实现**。第一步（FR-1003 的安全边界：档案恢复四项约束 +
> 默认关的开关 + 门禁）与第二步（两个任务 + `/plan` 页 + 本地复算）都已落地，口径见 §4.2 的两段
> 「实现补充」。下面几处是按本节契约实现时**有意补上**的，交接时不要改回去：
>
> - 动作多了 `equipment`（要用的器材）：本地白名单校验必须知道这个动作要用什么，不申报就只能猜；
> - 落库的 `estimatedMinutes` 是**本地按组数算的**，模型写的那份只在偏差 >25% 时进提示；
> - 伤病约束**没有来源**（档案瘦身时下线了 `injuries`，FR-1003 只要求恢复四项），输入里不含它。

**输入**：今日缺口、近 14 天各肌群组数与最近训练时间、目标组数下限、可用器材、伤病约束、上次同动作的 `组x次x重量`。

**输出**

```json
{
  "focus": "一句话重点",
  "estimatedMinutes": 45,
  "exercises": [
    { "name": "杠铃深蹲", "muscles": ["腿"], "sets": 3, "reps": 8, "weightKg": 40,
      "rpe": 7, "progression": "比上次 +2.5kg", "reason": "腿部本周 0 组，欠账最多" }
  ],
  "notes": ["…"]
}
```

**本地处理**：动作与器材需通过档案白名单校验（用到不存在的器材则剔除该动作并提示）；`weightKg` 与上次记录比对，超出 +10% 时提示确认（避免激进加重）。

### 6.6 契约四：`plan.meal`

> **2026-10-16 状态**：同 §6.5 —— **已实现**。落库的 `totals` 是本地按食物库算的那一份（`totalsPreview`
> 只留痕比对），命中不了库的行不进合计并写进 `missing`；采购清单原样保留（FR-804，本地不查库存）。

**输入**：剩余热量与蛋白、钠是否超上限、纤维缺口、忌口 / 过敏、调味料有无、可用器材、每餐可投入时间、食物库中与蛋白质相关的高频条目名（只给名称，不给全量数值）。

**输出**

```json
{
  "title": "…",
  "items": [{ "food": "鸡胸肉(生 去皮)", "grams": 200, "dish": "香煎" }],
  "seasonings": [{ "food": "食用油", "grams": 8 }],
  "totalsPreview": { "kcal": 0, "proteinG": 0, "fatG": 0, "carbG": 0 },
  "shoppingList": [{ "item": "鸡胸肉", "amount": "500g", "substitute": "鸡腿肉去皮" }]
}
```

**本地处理**：**忽略 `totalsPreview`**，一律用 `foods` 重新计算四项合计并展示（FR-806）；若重算与模型自报偏差 >15%，提示「模型给出的估算与本地库不一致，已按本地库显示」。

### 6.7 契约五：`calibration.review`

**输入**：TDEE 反推结果与样本量、近 4 周体重均线、近 4 周平均摄入与达标率、当前目标、上次校准时间与幅度。

**输出**

```json
{ "recommended": true, "deltaKcal": -120, "direction": "下调",
  "confidence": "medium", "rationale": "…", "watchItems": ["…"] }
```

**本地处理**：`\|deltaKcal\| > 150` 或距上次校准 <14 天时，降级为「不建议现在调整」并说明原因（FR-904 / FR-905）。

**实现补充（2026-10-16，已实现）**：落点 `llm/tasks/calibration.ts`（契约）+ `domain/calibrationReview.ts`
（本地门禁）+ `application/calibration.ts`（拼输入 / 调模型）+ `pages/CalibrationPage.vue`（`/calibration`）。
入口是目标页顶部那张常驻的「校准向导」卡片。下面几处是把契约落成口径时定的，交接时不要改回去。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 输入的数字从哪来 | 复用报告的 28 天摘要（`buildReportDigest` 的同一套聚合）：实测 TDEE 与样本量、体重均线 / 变化率、平均摄入与达标率、当前目标 | 校准要判的就是「这 4 周的账」，与报告同源才能解释得清为什么两边给的建议一样 |
| 覆盖率的分母 | **28 个自然日**（没记录的天也占位），不是「有记录的天数」 | 否则只记 3 天也会被算成 100%，样本门禁形同虚设（FR-708） |
| 幅度门禁在本地再判一次 | 模型回的 `deltaKcal` 超过 ±150 kcal 时，在本地拦下并归零（不是只写进提示词让模型自觉） | FR-904 是安全边界；`proposeCalibration` 的限幅只保护本地建议，模型完全可以回一个 −400 |
| 拦下即归零 | 任何一道门禁拦下后，`recommended` 置 false、`deltaKcal` 归 0、`direction` 置「不变」，原幅度写进提示文本 | 与报告 `applyCalibrationGate` 一致：作废的建议不该留在结构化字段里等着被谁读走 |
| 三条自洽修正 | ① 说「建议调整」却给 0 幅度 → 当成不建议调整；② 方向与幅度符号不一致 → 以幅度为准；③ TDEE 样本 < 7 天 / 覆盖率 < 50% 与频率、幅度共用一道闸门 | 数字是硬事实、词不是；同一批门禁一次判完，界面只需要看 `blocked` 一个布尔 |
| 频率门禁读哪个字段 | 优先用最近一行校准记录的 `date`（算 `daysSince`），没有记录时退回 `targets.lastCalibrated`（幅度按 0 记） | `applyCalibration` 本来就同时写记录与 `lastCalibrated`；退回是为了兼容只有标记的老数据 |
| 向导**不落库** | AI 复核结果只存在页面内存里；只有用户点「采纳」才 `applyCalibration`（写目标 + 留一行校准记录） | 校准是一次性动作：没有一个「待复核」状态需要用户回来收尾，也就没有过期记录要清理 |
| 没配模型 / 模型失败 | 本地数字与 `proposeCalibration` 的本地建议照常可用，生成按钮禁用并引导去 `/settings/model` | §9.3 降级矩阵：校准的数值区本身就不依赖模型 |

### 6.8 校验、重试与降级流水线

```
构造输入 ──▶ 缓存命中？ ──是──▶ 直接返回本地结果
                │否
                ▼
          发送请求（最小 payload）
                │
        ┌───────┴────────┐
   网络/限流失败        HTTP 200
        │                │
   退避重试 1 次          ▼
        │          剥离 ```json 包裹 ──▶ JSON.parse
   仍失败→入队            │
                        ▼
                Zod 结构校验 ──✗──▶ 重试 1 次（只附错误摘要）
                        │                    │
                        ✗ 仍失败 ────────────┘
                        │
                        ▼
                业务校验（范围/自洽/门禁）
                        │
              ┌─────────┴─────────┐
           通过                  标记可疑
              │                     │
              ▼                     ▼
        返回候选结果          返回候选 + 需确认项
              └──────────┬──────────┘
                         ▼
              application/ 决定落库或丢弃
```

重试请求体模板（**只追加错误摘要，不重发上下文原文以外的内容**）：

```json
{ "retry": true, "validationError": "items[0].sodium_mg expected number, received string" }
```

失败后的用户可见行为：显示原始响应片段（折叠）+ 人类可读的原因 + 「重试 / 放弃 / 手工录入」三个选项；**不写入任何数据**（FR-1405）。

### 6.9 token 控制策略汇总

| 策略 | 落地方式 |
| --- | --- |
| 本地优先 | 请求前查 `foods`（含 `nameNorm` 与别名）与当日报告缓存（FR-1408） |
| 请求最小化 | `buildPayload` 只输出白名单字段；**禁止**把 `days`/`intake` 原始对象直接序列化（DR-40） |
| 摘要化 | 报告输入由 `reportDigest` 聚合：均值、达标率、均线、组数，而非逐条记录（FR-1411） |
| 请求合并 | `food.resolve` 批量 ≤10 条；一次保存动作内的未知食物合并为一请求（DR-41） |
| 结果缓存 | 食物解析落 `foods` 永久缓存；推荐类结果缓存到当日（FR-1409 / FR-1413） |
| 输出上限 | 每任务 `maxOutputTokens`（食物 300、推荐 600、报告 1200），并在提示词中要求「不要解释过程」 |
| 禁止算数 | 换算、求和、占比、均线、达标率全部本地完成，不进入请求（DR-45 / FR-1410） |
| 图片瘦身 | 上传前本地压缩（长边 ≤ 1024px、JPEG 质量 0.7）并只发必要张数；单次请求图片 ≤ 3 张；图片 token 成本在发送前提示用户（FR-1417） |
| 提示词精简 | system prompt 固定 ≤ 200 字；JSON 结构以「键名 + 一行说明」给出，不写长范例 |
| 用量可见 | 每次调用记录 `promptTokensEst / completionTokensEst`（按 `chars/1.6`（中文）与 `chars/4`（ASCII）粗估）；设置页汇总（FR-1414） |
| 预算告警 | 单次请求估算（输入正文 + 图片 × 85 + 输出上限）超过任务预算（`inputBudget + maxOutputTokens`）2 倍时，先问「本次请求较大，是否继续」；**没有确认通道时照发**，队列重放与后台不受影响 |

### 6.10 队列与离线降级

`pendingOps` 队列条目：`{ kind: 'food.resolve' | 'report.generate', ref: id, attempts, lastError, createdAt }`。

- 无网 / 未配置模型时：条目不消耗重试次数，状态显示为「等待网络」；界面用角标显示待办数（FR-1504）。
- 恢复后：按 `createdAt` 顺序串行执行，每次执行前重新检查缓存命中。
- `attempts > 3` 的条目停止自动重试，转为「需要处理」，在数据页列出，可一键重试或删除。
- **记录链路永不阻塞**：任何队列积压都不影响继续记录与查看（DR-44 / NFR-02）。

### 6.11 契约六：`log.parse` / `log.parse.vision`（自由文本与图片输入）

**定位**：把「任意描述」变成「可确认的结构化草稿」。这是唯一允许把自然语言当输入的入口，也是唯一产出**草稿**而不是**数据**的任务（DR-48）。

**文本输入（`log.parse`）**

```json
{ "date": "2026-10-15",
  "text": "今天中午吃了一顿西红柿鸡蛋拌面，其中食材包含4个西红柿，5个鸡蛋，80g干重的干面条，油盐正常量",
  "mealHint": null,
  "expectedKind": "intake",
  "knownFoods": ["鸡蛋(全蛋 生)", "面条(干)"],
  "imageCount": 0 }
```

`knownFoods` 只给**名称**，让模型优先复用库里已有的标准名，不发送任何数值。
`expectedKind` 是入口意图（从「记饮食」进来就是 `intake`），用来在返回的 `kind` 与入口不一致时
提示用户选择，而不是静默改写。

**图片输入（`log.parse.vision`）**

文字与图片放在同一条 user message 的 `content` 数组里：`[{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,…' } }]`。

| 规则 | 值 |
| --- | --- |
| 张数上限 | 单次 ≤ 3 张 |
| 预处理 | 长边压缩至 ≤ 1024px、转 JPEG 质量 0.7、剥离 EXIF |
| 不落库 | 压缩后的图片只存在于内存，请求结束即释放（FR-1417） |
| 隐私提示 | 发送前提示「图片将发送到你配置的模型服务」 |
| 降级 | 模型不支持图片（400 / 明确报错）时提示「当前模型不支持图片输入」，文字部分单独走 `log.parse` |

**输出契约（两种输入共用骨架）**

```json
{
  "kind": "intake",
  "meal": "午餐",
  "dish": "西红柿鸡蛋拌面",
  "items": [
    { "food": "西红柿", "amountText": "4个", "grams": 600, "pending": false, "confidence": "medium" },
    { "food": "鸡蛋(全蛋 生)", "amountText": "5个", "grams": 250, "pending": false, "confidence": "high" },
    { "food": "面条(干)", "amountText": "80g", "grams": 80, "cookedState": "生", "pending": false, "confidence": "high" },
    { "food": "食用油", "amountText": "正常量", "grams": null, "pending": true, "confidence": "low" },
    { "food": "盐", "amountText": "正常量", "grams": null, "pending": true, "confidence": "low" }
  ],
  "clarify": [
    { "field": "面条(干).grams", "question": "面条的 80g 是干重还是煮熟后的重量？", "options": ["干重 80g", "熟重 80g", "记不清"] },
    { "field": "食用油.grams", "question": "炒这顿大概用了多少油？", "options": ["5g", "10g", "15g", "没量过，按 10g 估"] },
    { "field": "盐.grams", "question": "盐要不要单独记？（不记就留空）", "options": ["不记", "记 3g"] }
  ],
  "assumptions": [{ "text": "1 个西红柿按 150g 计" }],
  "uncertain": ["油盐用量"],
  "rawText": "今天中午吃了一顿……"
}
```

训练类输入复用同一骨架，`kind: "workout"`，`items` 换成动作条目：

```json
{ "kind": "workout", "type": "力量",
  "items": [{ "exercise": "深蹲", "sets": 4, "reps": 8, "weightKg": 60, "bodyweight": false }],
  "minutes": 40, "rpe": null,
  "clarify": [{ "field": "rpe", "question": "最后一组还能再做几次？",
                "options": ["还能做 1-2 次（RPE 9）", "还能做 3-4 次（RPE 8）", "差不多力竭（RPE 10）"] }],
  "assumptions": [], "uncertain": ["RPE"], "rawText": "…" }
```

**本地处理**

| 规则 | 处理 |
| --- | --- |
| `kind` 必须匹配入口 | 在「记饮食」页提交却返回 `workout` 时，提示用户选择，不静默改写 |
| `grams: null` 或 `pending: true` | 一律不落库为数值，进入澄清清单（DR-47） |
| `clarify` 非空 | 先在 UI 逐条询问，用户回答后再折算；回答「记不清」才允许留空 |
| 必填类字段 | 份量 / 克数、有氧时长、训练组次与重量属「无值即无法计算」，缺失必须问，不用默认值 |
| 名称归一 | `food` 先匹配库内条目（含别名）：命中则用库内标准名与数值，未命中才进 `food.resolve` |
| 本地折算 | 模型没给 `grams` 时，先在本地用「库内条目 + `amountText`」折算（`鸡蛋` + `5个` → `resolvePortion` → 250g），算得出来就直接填上并把依据写进 `assumptions`，不问用户 |
| 油盐类 | 必须单独成条（DR-15），默认进澄清清单 |
| 原文留存 | `rawText` 写入记录备注（FR-114） |

**图片请求的组装**：图片与文字放在同一条 user message 的 `content` 数组里，文字在前、图片在后；
任务声明的 JSON 契约只写在文字部分，图片是附加的 `extraUserParts`，因此 `food.resolve` 这类纯文本任务
完全不涉及图片分支。图片 token 按 85 tokens/张粗估，只用于「发送前提示成本」。

### 6.12 澄清引擎（Clarify）

**目标**：把「估不准」变成「问一句」，而不是「填一个数」（DR-47）。任何模型任务的输出都可以携带 `clarify[]` / `uncertain[]` / `assumptions[]`，统一由本引擎接管。

**判定：什么必须问、什么可以估**

| 类别 | 判据 | 行为 |
| --- | --- | --- |
| 可估算 | 有常见基准（1 个鸡蛋 ≈ 50g、一碗米饭 ≈ 150g 熟饭、一勺油 ≈ 10g）且能得出 `grams` | 直接填入，并在备注写明假设（DR-03） |
| 必须问 | 缺少「无值即无法计算」的字段：换算所需克数 / 份量、有氧时长、训练组次与重量 | 生成澄清问题，**阻塞该条目落库** |
| 可留空 | 用户声明不记的字段（不再追问名单）、非必需项（如 RPE 在时长与组次齐全时） | 留空并标注，不阻塞 |

**问题生成规则**

1. 优先复用模型给出的 `clarify[]`，但必须补齐本地检测到的缺失项（模型可能漏报）。
2. 同一字段只问一次；同一次提交里的多个缺失项合并为一张卡片，避免连续弹窗。
3. 每个问题尽量给**可点选选项**（常用值），减少打字；必须允许「记不清 / 不记」。
4. 措辞要具体：不问「份量多少」，而问「面条的 80g 是干重还是煮熟后的重量？」。
5. 用户回答后立即折算并回显（如「按干重 80g 计 ≈ 280 kcal」），让用户确认。

**与「不再追问」名单的交互**：`settings.mutedFields` 中声明的字段不生成问题；但若该字段是可计算所必需的（如体重缺失导致 MET 消耗算不出），只提示「该项缺失，相关指标留空」，不追问。

**记录链路保护**：澄清未完成时条目以**草稿**状态存在，可当天稍后继续回答；草稿不参与当日汇总（DR-48 / FR-113）。
---

## 7. 导入 / 导出设计

### 7.1 导出包格式

单文件 `.json`（便于 iOS 分享与跨设备传输；不用 zip 以减少兼容问题）：

```json
{
  "manifest": { "app": "thin-muscle-plan", "formatVersion": 1, "schemaVersion": 3,
                "exportedAt": "2026-10-15T21:00:00+08:00", "appVersion": "0.1.0",
                "counts": { "days": 5, "intake": 27, "workout": 6, "foods": 121, "reports": 2 } },
  "data": { "days": [], "intake": [], "workout": [], "foods": [], "reports": [],
            "targets": {}, "calibrations": [], "profile": {}, "settings": {}, "snapshots": [], "pendingOps": [] },
  "checksum": "sha256(data 规范化 JSON)"
}
```

规则：

- **绝不包含** `modelConfig` 与 `llmLogs`（FR-1305）；导出前明确提示「模型密钥不会被导出，新设备需重新配置」。
- 导出完成后展示「条目数 + 校验和」，便于用户事后确认文件是否完整。
- 导出文件默认命名为 `薄肌计划-export-YYYY-MM-DD.json`。

**实现补充（2026-10-16，已实现）**：落点 `io/exportPackage.ts`（组装）+ `io/importPackage.ts`（校验 / 预演 / 落库）+ `pages/DataPage.vue`（`/data`）。下面几处是把格式落成口径时定的，交接时不要改回去。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| `data` 里到底有哪几块 | `days` / `intake` / `workout` / `foods` / `reports` / `targets` / `calibrations` / `profile` / `settings` / `snapshots` / `pendingOps` / **`drafts`** / **`adviceLog`** / **`plans`** | 原设计写这行时还没有草稿、指导历史与推荐；三者都是用户自己的数据（草稿里还有他打的原文、推荐里有他看过的清单），不导出等于换设备就丢 |
| 不导出的三块 | `modelConfig`（FR-1305 明令）、`llmLogs`（可能带调用痕迹）、`meta`（本机启动标记：种子版本等，换设备本来就该重算） | 导出包里出现 token 是安全事故，不是功能取舍 |
| 校验和算在哪一层 | `sha256(规范化 JSON(data))`：对象键**递归排序**、丢掉 `undefined` 的键，数组保持原序 | 直接 `JSON.stringify` 会受键序影响 —— 同一份数据换个键序就得到不同校验和，导入时会把完好的文件判成"被改过" |
| 版本兼容 | `formatVersion` 只用整数、只允许**向后**读（`<=` 当前版本）；老包缺 `drafts` / `adviceLog` / `plans` 时补成空数组、不报错 | 加字段是加法，不该让旧文件失效；反过来（文件更新）必须拦住，因为可能有本应用读不懂的字段 |

### 7.2 工作区文本导出（可回迁）

除结构化导出外，提供「导出为工作区格式」副产物，生成一段可复制的文本 / 可下载的文件集合：

| 文件 | 生成方式 |
| --- | --- |
| `records/YYYY-MM-DD.md` | front-matter + AUTO 汇总区块（由 `domain` 计算生成）+ 摄入表 + 训练表 + 状态与备注 + 待办 |
| `data/foods.csv` | `foods` 表按既有列序导出（`source=llm` 的条目在 `note` 里注明来源与置信度） |
| `profile.md` / `targets.md` | 由单例对象按既有模板生成 |

验收方式：导出后用仓库脚本跑 `python scripts/nutrition.py check --all` 应无错误（FR-1206 / 需求 §13.14）。

**实现补充（2026-10-16，已实现）**：落点 `io/markdown/export.ts`（渲染）+ `io/workspaceExport.ts`
（读库 / 打包）+ `pages/DataPage.vue` 的「导出为工作区格式」卡片。下面几处是把格式落成口径时定的。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 交互形态 | 打包成**一个** `.md` 文本包，每个文件前一行 `<!-- thin-muscle-workspace: <相对路径> -->` | 与 §7.1 同一条理由：不用 zip，iOS 上分享与查看都省事；`splitWorkspaceBundle` 是它的逆运算 |
| 单元格数值 | 最多 3 位小数（不是工作区文件那种 1 位小数显示） | 导出是搬数据，不该顺手砍精度；脚本与解析器都只取单元格里的第一个数字 |
| AUTO:SUMMARY | 由本地渲染（`summaryBlockLines`），规则逐字对齐脚本的 `summary_lines` | DR-45：数字永远本地算；用户跑 `totals --write` 时脚本会覆盖成同样的一段 |
| 区块位置 | 固定在 `## 待办` 之后 | 正文按 `##` 切段，区块因此落在「待办」段里；若跟着备注段，整段（含表格）会被 `parseRecord` 当备注读回来 |
| 行序 | 按内容排（摄入「餐次 → 菜品 → 食材」、训练「时间 → 动作」），不按主键 | `id` 只有毫秒时间戳加随机后缀，同毫秒落库的两条顺序随机 —— 同一份数据会导出成不同的文件 |
| 日期范围 | `days` / `intake` / `workout` 三张表的并集 | 只记了一餐（还没建 `days` 行）或只建了空的一天，都不该在导出里凭空消失 |
| `foods.csv` 的 note | 保留 `edibleNote` / `sourceNote`；`source=llm` 追加「来源：模型（置信度 x）」；非 100g/100ml 基准补 `1<unit>=<g>g` | FR-405 的来源留痕导出后不能丢；`gen-seed.mjs` 还会拒收没有 note 的非 100g 条目 |
| 档案 / 目标的正文 | 只写应用真的持有的字段（2026-10-16 起档案重新有忌口 / 过敏 / 可用器材 / 每餐时间，见 §4.2 的「实现补充」） | 不生成「填了但没人读」的空段落；front-matter 的键名照旧，脚本照旧能读 |

验收：`tests/workspace-export.spec.ts`（导出 → `parseRecord` 往返一致、文本包往返一致）
与 `tests/workspace-script.spec.ts`（把导出结果摊进临时工作区，**真跑** `check --all`，
并逐日比对我们与脚本各自写的 AUTO 区块；没装 Python 的环境整组跳过）。

### 7.3 Markdown 解析器（导入用）

- 解析 front-matter（含 `weight_kg` / `water_ml` 兼容字段，保留但不展示）。
- 表格解析按**列名关键字**匹配，容忍列序变化（契约要求）。
- AUTO 区块内容**不信任**：导入后由 `domain` 重算覆盖，避免把旧口径的数字带进来。
- 解析失败必须定位到「文件 + 行号 + 原因」，并允许跳过该文件继续导入（FR-1111）。
- 文件末尾的备注与待办原样保留。

### 7.4 导入流程

1. 选文件 → 校验 `formatVersion` / `schemaVersion` / `checksum`。
2. **预览差异**：新增多少天、多少条、多少食物；与本地冲突的日期列表。
3. 冲突策略（用户可选，默认安全）：
   - `跳过`：保留本地，不动冲突日；
   - `合并`：按条目 id 去重并集，`days` 头部字段逐字段取「非空优先，两边都非空取导入值并留痕」；
   - `覆盖`：仅对用户显式勾选的日期生效（危险操作，二次确认）。
4. 导入食物库时按 `nameNorm` 去重，冲突条目保留本地版本并把导入版本记为别名候选。
5. 导入完成后重算受影响日期的汇总快照，并展示「导入报告」（成功 / 跳过 / 冲突条数）。
6. 单例对象（`profile` / `targets` / `settings`）默认**按字段合并**，不整体覆盖（避免冲掉本机「不再追问」名单）。

**实现补充（2026-10-16，已实现）**：`io/importPackage.ts` 的 `parseExportPackage` / `previewImport` / `applyImport`。

| 点 | 口径 | 为什么 |
| --- | --- | --- |
| 校验失败怎么办 | **整包拒绝**，不提供「部分导入」 | §10.1 把校验和不符 / 版本更新归到「数据完整性错误」；半包数据的危害比不导入大得多 |
| 为什么不用一个事务包住整包 | 单条不合法只影响那一条、其余继续，最后给「成功 / 跳过 / 冲突」报告 | 与 FR-1111「允许跳过该条继续」一致。代价是可能落下半包 —— 所以每次导入都要报数 |
| 合并时字段怎么取 | `days` 的头部字段逐字段：文件为空就留本机、两边都有就取文件并记一笔 `日期.字段` | 记录条目按 id 并集都留着，但同一天只能有一份体重 —— 取"后导入的"并留痕比静默二选一好 |
| 单例谁优先 | 本机非空的值优先，只补本机没有的字段 | 换设备时"本机的记录口径与设置"更贴近这台设备；也避免冲掉「不再追问」名单 |
| 覆盖策略的边界 | 只覆盖用户**显式勾选**的日期；没勾的按跳过处理；默认策略永远是「跳过」 | 「覆盖」不可逆，默认值必须是安全的那一个 |
| 汇总快照 | 文件里的 `summarySnapshot` **一律不采信**，导入后按本地口径重算（`application/daySummary.ts`） | §7.3 同一条纪律：AUTO 区块的数字不信任，防止旧口径的数字被带进来 |
| 食物重名 | 按 `nameNorm` 去重、保留本地版本，只把导入版本记成"疑似别名"计数 | 不静默改本机食物库的数值（食物别名治理是 T4.4） |

---

## 8. 界面设计

### 8.1 路由表与导航树（2026-10-16 重构）

**先声明树，再渲染。** 导航结构的唯一数据源是 `app/src/app/nav.ts`：底部 tab（域）由它派生，
页头那条域导航条与面包屑由 `components/AppHeader.vue` 按当前路由读它渲染，
`app/src/router/index.ts` 的路由表与它一一对应（`tests/navigation-reachability.spec.ts` 逐条比对）。
**新增页面必须在这里登记**，否则「页面上没有同级入口」这种看不出来的毛病会直接变成测试失败。

**五个域（= 底部 tab）**，覆盖全部路由，不留孤岛：

| 域（tab） | 域根 | 域内页面 |
| --- | --- | --- |
| 今日 | `/today` | 当日汇总 `/summary` · 今日指导 `/coach` · 推荐清单 `/plan` |
| 记录 | `/log/diet`（饮食面板） | 训练 `/log/workout` · 身体 `/log/body` · 一句话记录 `/log/quick` · 食物库 `/foods` |
| 分析 | `/trend` | 报告 `/reports`（详情 `/reports/:id`）· 目标与校准 `/targets` · 校准向导 `/calibration` |
| 我的 | `/me` | 档案 `/profile` · 数据 `/data` · 关于与免责声明 `/about` |
| 设置 | `/settings` | 模型与 AI `/settings/model` |

分域依据是「这一页回答什么问题」：今日 = 今天怎么样；记录 = 把今天记下来（含食物库治理）；
分析 = 看数据与调目标（趋势 → 校准 → 目标是一条链路的三段，报告是它的产出）；
我的 = 关于我这个人（档案、我的数据、免责声明）；设置 = 应用怎么跑（模型、提醒、偏好与外观）。
重构前「设置」同时装着这两类东西，`/coach` `/plan` `/foods` `/targets` `/calibration` `/profile` `/data`
则不属于任何 tab —— 走进去连高亮都没有，入口散在各页顺手加的按钮上（例如「今日指导」只能靠
今日页那张卡片上的「生成今日指导」进）。

**页头 = 统一的树状路径**（都由 `AppHeader.vue` 自动渲染，页面不写入口）：

1. **域导航条**（`.domain-nav`）：本域全部页面（含域根）的格子，当前页高亮。域根页上它是「本域目录」，
   二级页上它是「同层还有谁」。域根那颗格子默认写域的名字，**例外是「记录」域：它写「饮食」**
   （`NavDomain.rootLabel`）—— 因为记录域的根页就是饮食面板，写「记录」会和旁边的「饮食」指同一页，
   等于两个名字一件事。
2. **面包屑**（`.crumbs`）：只在层级 ≥ 3 时出现（`分析 › 报告 › 报告详情`），两级页面不重复画 ——
   高亮的那颗格子已经说明位置。

各页面明细：

| 路由 | 页面 | 备注 |
| --- | --- | --- |
| `/today` | 今日（默认页，今日域根） | 进度环、缺口提示、快捷录入；「当日汇总 / 今日指导 / 推荐清单」由域导航条给，页面上不再挂「更多」卡片 |
| `/log/diet` | 饮食（记录域根） | 域根就是**饮食面板**（2026-10-16 起；旧地址 `/log` 在路由表里转过来）。三块面板（饮食 / 训练 / 身体）共用一个壳 `LogHubPage`，**日期由这一层统一持有**，切换不丢日期；**同级切换即页头的域导航条**（`/log/diet` `/log/workout` `/log/body` `/log/quick` `/foods`），页头标题取当前面板名 |
| `/log/:kind(diet\|workout\|body)` | 记录壳（训练 / 身体） | 与域根同一个壳，`kind` 必填；以前 `/log` 与 `/log/diet` 是两条路由渲染同一个面板，页头会并排出现「记录」「饮食」两颗指向同一页的格子 |
| `/log/quick` | 一句话 / 拍照记录 | 文本或图片 → 解析草稿 → 逐项确认（FR-110 / FR-111 / FR-113） |
| `/summary/:date?` | 当日汇总 | 不完整时置顶提示 |
| `/trend` | 趋势（分析域根） | `?days=7\|14\|28` |
| `/coach` | 今日指导（A 级） | 摘要 v2 + 当日缺口 → 带依据的建议；含「将要发送的内容」预览与采纳/不采纳（§6.4.2 / FR-1602） |
| `/plan` | 推荐清单（B 级） | 「今天练什么」+「今天还能吃什么」；默认关，开关开了且四项约束齐了才给生成（FR-1003）；数值一律按本地库复算（§6.5 / §6.6 / T3.8） |
| `/reports` / `/reports/:id` | 报告列表 / 详情 | 待生成报告置顶；列表与详情都能删（报告是本地产出的视图，删它不动原始记录，只做二次确认）；详情是唯一的**三级**页面（面包屑 `分析 › 报告 › 报告详情`） |
| `/foods` | 食物库 | 条目概况、按名称 / 来源（内置 / 模型 / 手工）/ 分类筛选；停用与删除（被记录引用过的删不掉，只能停用）；改数值（FR-406）。「疑似重复」分组卡片 2026-10-16 下线，FR-408 只剩新增时的合并提示（见 §4.2） |
| `/targets` | 目标 | 校准记录表 |
| `/calibration` | 校准向导 | 本地数字 + AI 复核；幅度 / 频率 / 样本门禁，采纳才写目标（§6.7 / T3.5） |
| `/me` | 我的（我的域根） | 档案与目标的现状 + 本机数据（schema / 食物库条目 / 种子版本 / 待办队列）；「档案 / 数据 / 关于」由域导航条给 |
| `/profile` | 档案 | |
| `/data` | 数据 | 导出 / 导入 JSON（含预演与三种冲突策略，T4.1）、工作区文本导出（T4.2）、快照与单日回滚（T4.3）、离线队列界面与诊断信息导出（T4.6）+ 存储占用 |
| `/about` | 关于与免责声明 | 需求 §9 的七条原文 + 数据存在哪 + 版本（T4.6） |
| `/settings` | 设置（设置域根） | 按主题分四组：模型与 AI（模型设置入口 + 生成式推荐开关）、提醒（T4.5）、偏好与外观（T4.6）、不再追问的字段 |
| `/settings/model` | 模型与 AI | URL / token / 连通性 / 用量 |

底部 Tabbar 与页头导航条的规则（2026-10-15 起，2026-10-16 推广到全部页面）：

- **高亮按域匹配**：`domainOf(path)` 用 `match` 前缀（按整段比，`/me` 不会匹配 `/member`）判定页面属于哪个域；
  `/log/*` 与 `/foods` 归「记录」、`/reports/:id` 归「分析」。每个页面**恰好归一个域**，不会出现「一个 tab 都不亮」
  （由 `tests/navigation-reachability.spec.ts` 保证）。
- **跳转一律走点击事件，不用 Tabbar 的 `change`**：`change` 只在选中项**发生变化**时触发，点一个已经高亮的
  tab 就成了死键——用户会卡在子页面里回不到首页。
- 由此，「今日」页的方格按钮（记饮食 / 记训练 / 记身体）跳到 `/log/diet|workout|body`，落地在「记录」域
  对应面板，用户随时能点底部「今日」返回。
### 8.2 状态管理

Pinia 只放**会话态与派生态**：

| store | 内容 |
| --- | --- |
| `useDayStore` | 当前选中日期、当日条目、汇总快照、是否有待补全 |
| `useSessionStore` | 模型可用性（已配置 / 连通 / 降级）、网络状态、队列计数 |
| `useUiStore` | 主题、上次停留 tab、toast / 弹层栈 |

业务数据集不复制进 store：页面通过 Dexie `liveQuery` 订阅对象存储，写操作走 `application/` 用例，写完由订阅自动刷新（单一数据源，避免 store 与库不一致）。

### 8.3 四个关键交互

**A. 记一餐时的未知食物**

```
输入「凯撒沙拉」──▶ 本地无命中
   │
   ▼
[卡片] 库里没有这个食物，要请模型解析吗？
       · 解析后会自动存入你的食物库，下次直接命中
       [请模型解析]  [手工录入]  [跳过]
   │
   ├─ 未配置模型 → 按钮变为「先配置模型」，并提供「手工录入」
   ├─ 离线 → 按钮变为「先占位，联网后自动补全」
   └─ 请模型解析 → 解析中（可取消）→ 结果确认卡片
        · 名称 / 分类 / 每 100g 六项 / 部分换算 / 来源说明 / 置信度
        · 可疑值黄色标记，低置信度需勾选「我已确认」
        [存入并记录]  [修改后存入]  [放弃]
```

**B. 生成周报 / 月报**

```
[报告页] 选择周 2026-W41
   │
   ▼
本地聚合（瞬时）→ 展示数值区（即使没有模型也有内容）
   │
   ▼
[生成结论] ──▶ 可折叠的「将要发送的内容」预览（FR-1602）
   │
   ▼
调用中（进度 + 取消）→ 返回 JSON → 校验 → 渲染
   │
   ├─ 不通过 → 自动重试一次 → 仍失败：错误卡片 + 原始响应（折叠）
   └─ 通过 → 数字守卫高亮「待核对」数字 → 可编辑文字 → 保存
```

**C. 待补全 / 待生成队列**

今日页与数据页各有一个角标入口；列表项显示类型、关联对象、失败原因、重试次数；支持「立即重试 / 全部重试 / 删除」。

**D. 一句话 / 拍照记录（`/log/quick`）**

```
[输入框] 中午吃了西红柿鸡蛋拌面，4个西红柿、5个鸡蛋、80g干面条，油盐正常量   [📷 上传图片]
   │ 提交
   ▼
解析中（可取消）→ 草稿卡片
   ├ 条目列表（可编辑：食材 / 份量 / 克数）
   ├ 待确认：面条的 80g 是干重还是熟重？   ○ 干重  ○ 熟重  ○ 记不清
   ├ 已填假设：1 个西红柿按 150g 计
   ├ 油 / 盐：正常量 → 需要补一个数字   [5g] [10g] [记不清]
   └ [确认并写入]  [继续修改]  [放弃]
   │
   ├ 未配置模型 → 「先配置模型」+「改用表单录入」
   ├ 离线 → 「先存为草稿，联网后解析」
   └ 图片模式 → 发送前提示「图片将发送到你配置的模型服务」
```

确认前草稿不进入汇总，也不写库；确认后复用表单链路完成换算、落库与当日汇总刷新。澄清未答完的条目留在草稿区，可在当天随时继续（DR-47 / DR-48）。
### 8.4 一致性与可访问性

- 关键数字（差额、占比、达标率）使用固定宽度与统一单位格式；「空值」一律显示 `-`，与真实 `0` 区分（DR-04）。
- 达标 / 超标不用颜色单独表达：同时给图标与文字。
- 所有表单控件使用原生 label；支持系统字号缩放；触控目标 ≥ 44px。
- 术语沿用契约（「菜品/做法」「组x次x重量」「晨重」），避免出现「卡路里」「组数x次数」等混用。

### 8.5 样式基元（2026-10-15 补）

- **设计 token 与共享类集中在 `app/src/style.css`**：颜色（`--brand` / `--accent` / `--danger` …）、
  圆角、阴影、间距做成变量；卡片 `.card`、键值行 `.kv`、数字块 `.stat`、进度 `.progress`、
  按钮网格 `.entry-grid` / `.link-grid`、提示 `.hint-list`、表格 `.data-table`、空状态 `.empty` 都是全局类。
  页面 `<style scoped>` 只写这一页特有的东西。
- **页面间距由 flex + `gap` 负责**（`.page` / `.panel`），卡片不再自带外边距 —— 这样「卡片套进别的容器」
  不会突然贴在一起，也不会出现双重内边距。
- **Vant 主题桥接**：在 `html:root` 覆盖 `--van-primary-color` 等变量，把组件默认蓝改成品牌绿，
  与打包顺序无关。
- **深色主题只换 token**（T4.6）：`:root[data-theme='dark']` 里重写同一套语义变量，并把 Vant 的
  `--van-background` / `--van-text-color` / `--van-cell-background` 等映射过来；`data-theme` 由
  `app/src/app/theme.ts` 按设置写到 `<html>`，同时给根节点加 / 去 `van-theme-dark`
  （Vant 的深色变量挂在这个类上，挂在根节点才能连 teleport 到 `body` 的弹窗一起照顾到）。
- **颜色只写 token**（2026-10-16 补）：`--warn-soft`（提醒卡片底）/ `--flag-soft`（「待核对」数字的高亮底）/
  `--on-danger`（危险色底上的文字）这类「柔和底色」也进 token，两套主题各自给值 —— 以前这几处直接写死
  浅色值（`#fffaf3` / `#fff3cd` / `#fff`），深色下就成了「浅黄底 + 浅灰字」，读不清。页面里**一律不许出现
  颜色字面量**，由 `tests/theme-tokens.spec.ts` 静态扫描守住（只放行 `style.css` 的 token 定义行）。
- **图表读不到 CSS 变量**（2026-10-16 补）：ECharts 把颜色画进 SVG，所以在 `app/src/app/chartTheme.ts` 里
  按外观给了两套取值（连 tooltip 的底色也要给 —— ECharts 默认写死白底，深色下点一下图就闪一块白），
  由同一个测试逐项比对回 token；页面用 `useResolvedTheme()`（`app/theme.ts`）跟着 `data-theme` 重画。
- **树状路径的基元**（2026-10-16 补，见 §8.1）：`.page-header`（页头外壳）、`.crumbs` /
  `.crumb-link` / `.crumb-here` / `.crumb-sep`（面包屑）、`.domain-nav` / `.nav-chip` / `.nav-chip--on`
  （域导航条），以及长页面用的 `.group` / `.group-title`（分组标题）。
- **共享组件**：`components/AppHeader.vue`（标题 / 副标题 / 返回 **+ 由导航树自动渲染的域导航条与面包屑**）、
  `components/ChipSelect.vue`（会换行的标签按钮组，单选 / 多选共用）、`components/EchartView.vue`
  （ECharts SVG 薄封装）、`components/DateNav.vue`、`components/InstallHint.vue`；
  导航树本身在 `app/src/app/nav.ts`（**新增页面先登记它**）。

---

## 9. PWA 与离线设计

### 9.1 manifest 与安装

```json
{ "name": "薄肌计划", "short_name": "薄肌计划", "start_url": "/today",
  "display": "standalone", "background_color": "#ffffff", "theme_color": "#2f7d5b",
  "icons": [{ "src": "/icons/192.png", "sizes": "192x192", "type": "image/png" }],
  "shortcuts": [
    { "name": "记一餐", "url": "/log/diet" },
    { "name": "记体重", "url": "/log/body" },
    { "name": "今日汇总", "url": "/summary" } ] }
```

- iOS：首次访问弹出引导（分享 → 添加到主屏），因为 iOS 必须在 Safari 内手动添加（FR-1501 / FR-1510）。
- 图标需含 maskable 版本，避免 Android 上被裁切。

### 9.2 缓存与更新策略

| 资源 | 策略 |
| --- | --- |
| 应用外壳（HTML/JS/CSS/图标/字体） | precache，`registerType: 'autoUpdate'` |
| LLM 接口请求 | **network-only，且不写入任何缓存**（隐私 + 正确性） |
| 静态托管上的其他资源 | stale-while-revalidate |
| 版本更新 | 新 SW 就绪时提示「有新版本，重启生效」；同时比对本机 `schemaVersion`，需要迁移时先迁移再放行 |

### 9.3 离线能力矩阵

| 功能 | 离线可用 | 离线时的表现 |
| --- | --- | --- |
| 记饮食 / 记训练 / 记身体 | ✅ | 命中本地库直接换算 |
| 一句话 / 拍照记录 | ⚠️ | 文本与图片先存为**本地草稿**，联网且已配置模型后再解析并进入确认流程 |
| 未知食物 | ⚠️ | 先占位（名称 + 份量），标记待补全，联网后补全并回算 |
| 当日汇总 | ✅ | 存在待补全条目时置顶提示「汇总不完整」（FR-506） |
| 趋势 | ✅ | 纯本地计算 |
| 报告数值部分 | ✅ | 可生成并查看 |
| 报告结论 / 推荐 | ❌ | 显示「未配置模型 / 无网络」+ 入队 |
| 导出 | ✅ | 本地生成文件 |
| 导入 | ✅ | 本地解析 |

### 9.4 提醒的可行性约束（重要修正）

**问题**：需求 M11 要求定时提醒（晨重 / 睡前重 / 周报 / 月报），但本产品**没有后端**，而 Web Push 必须有服务端推送；iOS 上后台定时唤醒也不可用。

**设计结论（TD-09，2026-10-15 修订）**：提醒只保留两种机制，均不依赖后端，**不做日历 / .ics 导出**：

1. **应用内提醒**：打开应用时检查「今天还没有晨重 / 睡前重 / 本周还没生成周报」，在今日页顶部提示（满足 FR-1104 的降级要求）。
2. **本地通知（能力探测）**：若浏览器支持且用户授权 `Notification`，则在**应用处于打开状态**时按设定时间触发；不支持时静默跳过，不影响其他机制。

`/settings` 页需明确写出这条限制，避免用户以为「设了时间就一定会响」。

**实现补充（2026-10-16 落地，T4.5）**：

- **判定是纯函数**（`domain/reminders.ts`）：`pendingReminders` 只问「今天还没完成的事」，`dueReminders` 再加一道
  「已经过了设定时间」—— 前者给应用内提醒，后者给本地通知。事实（星期几、这一周是否收尾、本月是否最后一天、
  今天有没有称重 / 记一餐 / 生成报告）由 `application/reminders.ts` 的 `buildReminderState` 查库凑出，
  **两条链路共用同一份事实**：否则会出现「卡片说还没称重、通知说你已经称过」这种自相矛盾。
- **五项与默认时间**：晨起称重 09:00 / 睡前称重 22:30 / 当天摄入还没记完 20:00 / 周末生成周报 20:00 /
  月初生成月报 20:00。默认值只有一份（`REMINDER_DEFAULTS`）；`settings.reminders` 里缺的项按 id 补
  （`mergeReminders`，**只读时补、不写库**，用户改过的时间与开关原样保留）。
- **「哪一天算这一周的最后一天」跟着 `settings.weekStart` 走**；报告口径仍固定按周一起算（§6.4）。两者不冲突：
  前者决定「什么时候提醒」，后者决定「报告算哪一段」。
- **通知链路**（`application/notify.ts`）每次实时读 `Notification.permission`（不缓存 —— 用户去浏览器设置里
  改回来能立刻生效）；「同一事项一天内不重复催」记在本机 `meta.reminderNotified`（不进导出包）。应用打开
  期间每分钟检查一次，并在 `visibilitychange` 回到前台时补一次（移动端后台会冻结定时器，只靠 `setInterval`
  会漏掉到点的那一分钟）。
- **没授权 / 不支持时整条链路静默跳过**，应用内提醒照旧（FR-1104）：今日页顶部的「今天还没记的」卡片与
  `/settings` 的提醒清单都不依赖任何系统权限。

---

## 10. 错误处理与可观测性

### 10.1 错误分类与处理

| 类别 | 例子 | 处理 |
| --- | --- | --- |
| 用户输入错误 | 组次重量格式非法、体重越界 | 就地提示，不阻塞保存；非法格式按 1 组统计并告知（FR-202） |
| 数据完整性错误 | 导入文件 checksum 不符、记录解析失败 | 阻断该条目的导入，列出「文件 + 行号 + 原因」，其余继续（FR-1111） |
| 模型配置错误 | URL 拼错、401、404 | 连通性测试给出明确原因与修复建议，提供「查看将要发送的请求地址」 |
| 模型响应错误 | 非 JSON、字段缺失、数值离谱 | 重试一次 → 丢弃并提示；不落库（FR-1405） |
| 网络错误 | 断网、超时 | 入队等待，界面显示「等待网络」，不报错弹窗 |
| 解析缺项 | 一句话 / 图片解析后必填项为空 | 进入澄清清单并阻塞该条目落库，绝不用默认值填充（DR-47） |
| 模型不支持图片 | vision 请求返回 400 | 提示「当前模型不支持图片输入」，文字部分单独走文本解析 |
| 存储错误 | 配额超限、持久化被拒、迁移失败 | 数据页给出占用与清理入口；迁移失败自动回滚快照 |

### 10.2 日志与用量

- `llmLogs` 记录：`taskId`、`taskVersion`、`model`、`createdAt`、`durationMs`、`promptTokensEst`、`completionTokensEst`、`status`、`errorKind`。
- **不记录请求 / 响应正文**（可能含体重等敏感信息）；调试模式可选开启，开启时明确警告，并在退出时清除。
- 数据页提供：「清空调用日志」「查看用量汇总」「诊断信息导出」（版本、存储占用、最近 20 条错误，不含任何健康数据与密钥）。

**实现补充（2026-10-16 落地，T4.6）**：

- 「清空调用日志」与「查看用量汇总」在 `/settings/model`（T2.5 就做了）；「诊断信息导出」落在 `/data`，
  由 `io/diagnostics.ts` 组装：应用版本 / schema / 导出格式版本、运行环境（UA / 语言 / 在线 / 时区）、
  **每张表的条数**、存储占用、模型接口的非机密配置（地址 / 模型名 / 是否支持 JSON 模式）、
  调用日志汇总、以及最近 20 条错误（队列的失败原因 + 调用日志的错误分类）。
- 三条硬约束由 `tests/diagnostics.spec.ts` 钉住：**不出现 `apiKey`（连字段名都不出现）**、
  不出现任何记录内容（饮食名 / 体重只以条数出现）、错误最多 20 条。
- 同一页给出「离线队列」界面：未完成项的状态 / 参考对象 / 重试次数 / 最近一次错误，可手动「立即重试队列」、
  对某条「不再自动重试」（只删队列项，**记录仍是待补全**），以及清掉已完成的历史队列项。

---

## 11. 测试策略

| 层级 | 工具 | 覆盖内容 |
| --- | --- | --- |
| 单元测试 | Vitest | `domain/` 全部纯函数；边界：缺值、单值、跨月、闰年、ISO 周边界 |
| 对拍测试 | Vitest + Python 脚本 | §5.3：用真实记录 fixture 比对汇总 / 趋势 / TDEE，容差 0.05 |
| 契约测试 | Vitest | 六个 LLM 任务的 Zod schema：合法样例通过、畸形样例（缺字段、类型错、越界、带 Markdown 包裹）必须被拒绝 |
| 守卫测试 | Vitest | 数字一致性守卫：输入含 1623.6，模型文本写 1500 时应被标记 |
| 导入导出测试 | Vitest | 往返一致性：导入 fixture → 导出 → 再导入 → 数据集等价；导出后用 Python `check --all` 验证 |
| 迁移测试 | Vitest | 旧版本 fixture → 迁移 → 断言字段完整 |
| 端到端 | Playwright | 离线记录、未知食物补全流程、报告生成（mock 模型接口）、导入冲突的三种策略 |
| 澄清测试 | Vitest | 缺份量 / 缺时长 / 缺 RPE 的输入必须产出澄清问题而非默认值（DR-47） |
| 图片测试 | Vitest + mock | 压缩产物尺寸与体积上限；vision 响应缺字段时走澄清而非落库 |
| 手动清单 | 人 | iOS 加到主屏、iOS 数据持久性、Android 安装、桌面安装、真机性能 |

模型接口一律在测试中 mock：用固定 JSON 样例模拟「正常 / 非 JSON / 缺字段 / 越界 / 超时」五种响应，保证测试不花钱、可重复。

---

## 12. 工程结构

```
src/
  app/                 启动、路由、全局布局、错误边界
    nav.ts             导航树（域 → 页面）：底部 tab、页头域导航条、面包屑的唯一数据源（§8.1）
    theme.ts           外观（FR-1606）：三选一 → 写 <html data-theme> + van-theme-dark，跟随系统时监听变化；
                       还给拿不到 CSS 变量的图表提供 `useResolvedTheme()` / `currentTheme()`
    chartTheme.ts      图表的两套取值（ECharts 读不到 CSS 变量）：与 style.css 的 token 逐项对齐
    budget.ts          预算告警的界面出口：把 runTask 的估算转成「是否继续」确认框（§6.9）
  domain/              纯计算（§5.1），无 IO
    foodEdit.ts        手改数值（FR-406）：草稿解析 / 校验（越界只提醒）/ 只换六项
    nutrientRange.ts   六项数值的合理区间（模型校验与手改共用同一份）
    reminders.ts       提醒判定（未完成项 / 到点判定 / 默认项补齐 / 补记入口，纯函数）
    recommend.ts       B 级推荐的安全边界（四项约束齐没齐 / 拆分 / 拼成输入行）
    plan.ts            推荐的本地加工（FR-806 按库复算 / 器材白名单 / 加重与时长提示 / 缺口对照）
    fingerprint.ts     缓存指纹（稳定序列化 + djb2）：每日指导与推荐共用同一份实现
  data/
    db.ts              Dexie schema 与版本迁移
    repositories/      days / intake / workout / foods / reports / targets / profile / settings / snapshots / adviceLog / plans
    seed/              foods.seed.json（由 data/foods.csv 构建期生成）
  llm/
    client.ts          OpenAI 兼容客户端：一次请求、超时、错误分类、baseUrl 归一化、并发 1
    errors.ts          LlmError 分类（重试 / 入队 / 提示三种处置）
    text.ts            剥 ``` 包裹、配平抽取 JSON、token 估算
    types.ts           LlmTask 契约（buildPayload / Zod schema / 输入预算与输出上限 + 预算告警阈值）
    index.ts           runTask 流水线（校验重试、response_format 降级、预算告警、调用日志）与 probeModel
    tasks/             每个契约一个文件：food.resolve / log.parse / report.* / coach.daily / calibration.review / plan.*
  application/         用例层：本地优先、业务校验、落库编排
    foodLibrary.ts     库内查找（精确 + 有限模糊）与「给模型看的名字清单」
    foodAdmin.ts       食物库治理（概况 / 停用 / 删除保护 FR-412）
    foodResolve.ts     food.resolve 应用层（缓存命中 / 范围与宏量校验 / 去重 / 失败入队）
    logParse.ts        log.parse 应用层（草稿 + 澄清清单 + 失败保原文）
    snapshot.ts        快照与单日回滚（自动快照 / 整天替换 / 回滚前再拍一张）
    reminders.ts       提醒的事实来源（查库凑星期 / 当天记录 / 报告，判定交给 domain）
    notify.ts          本地通知（权限能力探测 + 一天只弹一次 + 应用内每分钟检查）
    report.ts          报告用例（本地摘要 + 覆盖率 / 数字守卫 / 校准幅度三道闸门）
    coach.ts           每日指导用例（依据校验 / 样本门禁 / 同日缓存 / 「采纳」表态）
    calibration.ts     校准向导用例（拼输入 + 调模型；幅度与频率门禁在 domain/calibrationReview.ts）
    plan.ts            推荐用例（门禁 FR-1003 → 请求 → 本地复核 → 落 plans 当日缓存）
  io/
    markdown/record.ts 记录文件解析（front-matter、章节、表格、组次文本）
    markdown/export.ts 导出回 Markdown / CSV（记录 + 档案 + 目标 + 食物库，含 AUTO 区块）
    exportPackage.ts   导出包构建与校验
    importPackage.ts   导入与冲突策略
    workspaceExport.ts 工作区文本导出（读库 + 打包成单个文本包）
    snapshot.ts        日快照载荷格式与结构校验（回滚前必须先过这里）
    diagnostics.ts     诊断信息导出（T4.6：版本 / 表条数 / 非机密配置 / 最近 20 条错误，不含 token 与记录内容）
  ui/
    pages/             今日 / 记录 hub（饮食·训练·身体）/ 汇总 / 趋势 / 报告 / 食物库 / 我的 / 档案 / 设置 / 关于（阶段 4 起无占位页；导航见 app/nav.ts）
    components/        DateNav 等共享组件
    composables/ charts/  （阶段 3 接入）
  store/               Pinia（会话态与派生态，写操作后统一重算并落库汇总）
tests/
  fixtures/            records / profile / targets 原始文件 + 期望值
  helpers/fixtures.ts  对拍公共工具（容差、期望值解析、fixture → 领域对象）
scripts/
  gen-seed.mjs         从 data/foods.csv 生成 foods.seed.json
  gen-expected.mjs     调用 nutrition.py 生成对拍期望值（含临时目录里的合成 TDEE 样本）
  deploy-pages.mjs     发布到部署仓库（GitHub Pages）：构建带 base → 同步产物 → 提交推送
```

构建与质量：`vite build` 产出纯静态 `dist/`；启用 TypeScript strict（含 `noUnusedLocals`）；
提交前跑 `npm run expected`（口径没变时可跳过）与 `npm test`。ESLint + Prettier 尚未接入。

分发：产物托管在独立仓库（`npm run deploy`，见根 `README.md` 的「部署与分发」）。路径前缀只由构建时的
`base` 决定 —— manifest 的 `scope` / `start_url` / 图标与 Workbox 的 `navigateFallback` 全写**相对**地址，
所以根路径与子路径（GitHub Pages 项目页）共用同一份配置；`404.html` 由部署脚本从 `index.html` 复制，
用来做 GitHub Pages 的 SPA 回退。

---

## 13. 实施计划

按依赖顺序拆成可独立验收的任务。P0 为「可以开始日常使用」的最小闭环。

> 各任务的**当前状态**、缺口与交接信息见 `docs/pwa-progress.md`；本节只描述任务本身与验收标准。

### 阶段 0：地基

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| T0.1 | 工程脚手架（Vue3 + TS + Vite + Pinia + Router + Vant + Vitest） | ✅ 2026-10-15 完成：`npm test` 19 项通过，`npm run build` 通过（Playwright 留到 E2E 阶段接入） |
| T0.2 | PWA 接入（manifest、SW、图标、安装引导） | ✅ 2026-10-15 完成：manifest/SW/图标已生成并在 preview 下验证可访问；安装引导是今日页顶部的一次性提示（`InstallHint.vue`，已装不提示、关掉记 localStorage），进度文档 §2.5 |
| T0.3 | Dexie schema v1 + 迁移框架 + 仓储层 | ✅ 2026-10-15 完成：14 个对象存储、9 个仓储模块，单测覆盖索引/幂等/校准留痕/队列 |
| T0.4 | 种子库存生成脚本（`foods.csv` → `foods.seed.ts`） | ✅ 2026-10-15 完成：生成 114 条，首次启动幂等写入，今日页可见条目数 |

### 阶段 1：本地能力闭环（P0 核心）

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| T1.1 | `domain/portion\|nutrition\|targets\|format` | ✅ 2026-10-15：`fixtures-totals.spec.ts` 逐项对拍（六项 + 占比 + 提示文案逐字） |
| T1.2 | `domain/training` | ✅ 2026-10-15：`fixtures-trend.spec.ts` 对拍容量负荷、组数、动作明细；MET 消耗单测对齐记录里的 274 kcal |
| T1.3 | `domain/weight\|adherence\|tdee\|calibration` | ✅ 2026-10-15：逐日体重 / 均线 / 净流失 / 变化率 / 达标率 / TDEE / `init` 全部对拍 |
| T1.4 | 记饮食 / 记训练 / 记身体三个页面 + 校验 | ✅ 2026-10-15：三个面板 + `store/day.ts`，端到端用例见 `day-store.spec.ts`（真机 60 秒记一餐待人工验收）；页面结构在同日改为 `/log/:kind?` 容器 + 顶部子 tab，见 T1.7 |
| T1.5 | 当日汇总页（含占比、缺口提示、不完整标记） | ✅ 2026-10-15：`SummaryPage.vue`，文案与阈值复用 domain，与脚本输出同源 |
| T1.6 | 趋势页（ECharts） | ✅ 2026-10-15：`TrendPage.vue` + `domain/trend.ts`（区间聚合与脚本 `trend` 逐项对拍，`tests/trend.spec.ts`）；7/14/28 切换写进 `?days=`，区间不足 7 天不外推周均，只有睡前重的日期单列标注 |
| T1.7 | 底部 tab 与「记录」hub 的导航修正 | ✅ 2026-10-15：`/log/:kind?` 归入「记录」、高亮按前缀分组、跳转改走 `@click`（不再依赖 `change`）；回归用例见 `tests/pages.spec.ts`，含「点已高亮的 tab 仍能跳转」 |

### 阶段 2：模型能力（P0 收口）

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| T2.1 | 模型配置页 + 连通性测试 | ✅ 2026-10-15：`ModelSettingsPage.vue` + `probeModel`；401/404/超时/非 JSON 分类见 `llm-client.spec.ts`，探测结果与上次测试结论写入配置（`model-settings-page.spec.ts`） |
| T2.2 | LLM 客户端（重试、超时、`response_format` 降级） | ✅ 2026-10-15：`llm/client.ts` 只做一次请求 + 错误分类，重试/降级集中在 `runTask`；并发上限 1（串行）有单测；降级后写 `supportsJsonResponse=false` 备忘录 |
| T2.3 | `food.resolve` 任务 + 确认卡片 + 落库 | ✅ 2026-10-15：`application/foodResolve.ts` 本地优先（含有限模糊匹配）、范围 + 宏量自洽 + 酒精豁免校验、去重提示；`food-resolve.spec.ts` 覆盖。确认卡片 UI 先接在「一句话记录」的落库链路里，「食物库」页的治理界面属 T4.4 |
| T2.4 | 待办队列 + 离线占位 + 回填回算 | ✅ 2026-10-15 完成：失败按「等网络 / 需处理」写入 `pendingOps`，未算出的条目以 `pendingFlag` 占位（汇总标「不完整」）；执行器 `application/queue.ts` 在启动与 `online` 事件时串行重放，可疑值转 `needs-attention` 等用户拍板，界面在 `/data` 的离线队列卡片（进度文档 §2.5） |
| T2.5 | token 用量统计与预算告警 | ✅ 2026-10-16：每次调用写 `llmLogs`（只有估算值与状态，无正文），模型设置页汇总次数 / 失败数 / 输入输出估算并可清空；每个任务声明 `inputBudget`（FR-1413），估算超任务预算 2 倍时 `runTask` 交给 `options.confirm` 问一句，界面实现是 `app/budget.ts`（`confirmOverBudget`），没接确认通道的一律照发 —— 见 §6.9 与进度文档 §2.21 |
| T2.6 | `log.parse` 自由文本解析 + 草稿确认交互 + 澄清追问引擎 | ✅ 2026-10-15：`LogQuickPage.vue` + `store/draft.ts` + `domain/clarify.ts`；草稿存 `drafts` 表，问题按 `<条目>.<字段>` 去重、阻塞项优先、支持「不再追问」名单；`log-parse.spec.ts` / `clarify.spec.ts` / `quick-log-page.spec.ts` 覆盖「任意描述 → 草稿 → 追问 → 落库」与「模型失败也留住原文」 |
| T2.7 | `log.parse.vision` 图片记录（压缩、张数上限、隐私提示、草稿确认） | ✅ 2026-10-15 完成：本地压缩（长边 ≤1024 / JPEG 0.7 / 丢 EXIF）、单次 ≤3 张、发送前提示成本与「图片会发给你配置的模型服务」、请求结束即释放（不落库）；`unsupported-image` 时给两条出口（去掉图片改用文字重试 / 去模型设置换模型）。进度文档 §2.5 |

### 阶段 3：报告与推荐（P1）

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| T3.1 | `reportDigest`（本地摘要） | ✅ 2026-10-15：`domain/reportDigest.ts`，建在 `domain/trend.ts` 的区间聚合上；摘要不含原始记录（`tests/report-digest.spec.ts` 断言序列化后无食物名），与趋势逐项同源 |
| T3.2 | `report.weekly` / `report.monthly` + 数字守卫 + 数值/文字分区渲染 | ✅ 2026-10-15：`llm/tasks/report.ts` + `domain/reportGuard.ts`；守卫只放行「摘要里的数 / 0-100% 百分比 / 天周组常量」，其余标「待核对」；`report-generate.spec.ts` 覆盖 |
| T3.3 | 报告列表、历史版本、重新生成、人工编辑留痕 | ✅ 2026-10-15：`ReportsPage.vue` + `ReportDetailPage.vue`；重新生成新建记录、旧版本保留；人工编辑写 `editedByUser`，数值区不可编辑 |
| T3.4 | ~~`plan.training` / `plan.meal` + 本地复算~~ | ❌ **2026-10-16 决定不做推荐功能**（连带 §6.5 / §6.6 只作历史记录，`/plan` 路由已删除，档案里与推荐相关的字段也已下线）。**该决定同日被 T3.8 推翻**：推荐作为默认关的 B 级功能重新立项并已实现 |
| T3.5 | `calibration.review` + 校准向导（幅度与频率门禁） | ✅ 2026-10-16 完成：`CalibrationPage.vue`（`/calibration`）+ `llm/tasks/calibration.ts` + `domain/calibrationReview.ts`；三道本地门禁（样本 / 频率 / 幅度，超出 ±150 kcal 被拦下且不提供采纳）、向导不落库、采纳才 `applyCalibration`。口径见 §6.7 的「实现补充」 |
| T3.6 | 摘要 v2（睡眠 / 精力 / 酸痛、RPE、有氧消耗、钠与纤维、上一期数字） | ✅ 2026-10-16 完成：口径与三处有意收窄见 §6.4.1；报告页已显示这些数字 |
| T3.7 | **`coach.daily` 每日指导（A 级，P0）** + `/coach` 页 + `adviceLog`（schema v3） | ✅ 2026-10-16 完成：依据校验（NFR-13）、样本门禁、数字守卫与报告同源；同日缓存与手动刷新；采纳 / 不采纳进 `adviceLog`；没配模型时降级为本地缺口提示。口径见 §6.4.2 的「实现补充」 |
| T3.8 | B 级生成式推荐（可选开关，默认关） | ✅ 2026-10-16 完成（两步）：第一步是安全边界 —— 档案按 FR-1003 恢复忌口 / 过敏 / 可用器材 / 每餐时间四项约束，`domain/recommend.ts` 判定「齐没齐」，设置页开关**默认关且四项没齐就打不开**；第二步是任务本身 —— `llm/tasks/plan.ts` 两个契约 + `domain/plan.ts` 本地复核 / 复算（FR-806）+ `application/plan.ts`（门禁 → 请求 → 复核 → 落 `plans` 当日缓存）+ `pages/PlanPage.vue`（`/plan`）。口径见 §4.2 的两段「实现补充」与 §6.5 / §6.6 |

### 阶段 4：数据治理与打磨（P1-P2）

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| T4.1 | 导出包 / 导入（含三种冲突策略与预览） | ✅ 2026-10-16 完成：`io/exportPackage.ts` + `io/importPackage.ts` + `pages/DataPage.vue`（`/data`）；校验（应用 / 格式版本 / 数据库版本 / sha256 规范化校验和）→ 预演差异 → 三种冲突策略 → 导入报告，往返一致由 `import-package.spec.ts` 覆盖。口径见 §7.1 / §7.4 的「实现补充」。**「导出后 Python `check --all` 通过」属 T4.2**（工作区文本导出），本任务只做结构化 JSON |
| T4.2 | 工作区文本导出（records / foods.csv / profile / targets） | ✅ 2026-10-16 完成：`io/markdown/export.ts`（记录 / CSV / 档案 / 目标渲染，含本地算的 AUTO 区块）+ `io/workspaceExport.ts`（读库、按内容排序、打包成单个文本包）+ `/data` 的「导出为工作区格式」卡片；`tests/workspace-script.spec.ts` 把导出结果摊进临时工作区**真跑** `check --all`（0 个问题）并逐日比对我们与脚本写的 AUTO 区块。口径见 §7.2 的「实现补充」 |
| T4.3 | 快照与单日回滚 | ✅ 2026-10-16 完成：`data/repositories/snapshots.ts`（存取 + 保留上限）+ `io/snapshot.ts`（载荷与手写校验）+ `application/snapshot.ts`（自动快照 / 整天替换回滚）+ `/data` 的「快照与回滚」卡片；自动快照挂在「删单条记录」与「导入覆盖 / 合并之前」。口径见 §4.3 的「实现补充」 |
| T4.4 | 食物库治理（来源筛选、停用） | ✅ 2026-10-16 完成（「疑似重复」卡片同日下线，理由见 §4.2 与 T4.8）：`application/foodAdmin.ts`（概况、停用、删除保护）+ `pages/FoodsPage.vue`（`/foods`）。验收「被引用的条目不可删除」由 `foods-page.spec.ts`（按钮禁用）与 `food-admin.spec.ts`（业务规则拒绝并说明几条记录）两处钉住。口径见 §4.2 的「实现补充」；手改数值（FR-406）随后补齐，见下表 |
| T4.5 | 提醒方案落地（应用内提醒 + 能力探测的本地通知） | ✅ 2026-10-16 完成：`domain/reminders.ts`（纯判定）+ `application/reminders.ts`（查库凑事实）+ `application/notify.ts`（权限探测 / 一天只弹一次 / 前台每分钟检查）+ `/settings` 真页面（开关 / 时间 / 权限 / 限制说明）。今日页顶部「今天还没记的」卡片与它共用同一份判定。口径见 §9.4 的「实现补充」 |
| T4.6 | 设置、免责声明、诊断信息导出 | ✅ 2026-10-16 完成：`app/theme.ts`（外观三选一 → 写 `<html data-theme>` + `van-theme-dark`）、`/settings` 的偏好卡片（单位只读说明 / 周起始日 / 外观）与「不再追问」逐条恢复、`pages/AboutPage.vue`（`/about`：需求 §9 七条原文 + 数据在哪 + 版本）、`io/diagnostics.ts` 诊断信息导出（不含 token 与记录内容）、`/data` 的离线队列界面与诊断导出。口径见 §9.4 / §10.2 的「实现补充」 |
| FR-406 | 食物条目数值编辑 / 覆盖（DR-06 来源替换） | ✅ 2026-10-16 完成：`domain/foodEdit.ts`（草稿解析 / 校验 / 越界只提醒）+ `application/foodAdmin.ts` 的 `editFoodFacts`（来源替换成「手工」并留痕）+ `/foods` 每行的「改数值」内联编辑器。区间与模型校验共用 `domain/nutrientRange.ts`。口径见 §4.2 的「实现补充」 |

| T4.7 | **界面与菜单重构：导航树 + 五域 IA**（2026-10-16） | ✅ 2026-10-16 完成：新增 `app/src/app/nav.ts`（导航树，唯一数据源）与页头自动渲染的域导航条 / 面包屑（`components/AppHeader.vue`）；底部 tab 由「今日 / 记录 / 趋势 / 报告 / 设置」改为**五个域**「今日 / 记录 / 分析 / 我的 / 设置」（覆盖全部路由，消灭七个「不高亮」的孤岛页）；新开「我的」域根 `pages/MePage.vue`（`/me`：档案与目标现状 + 本机数据）；`/settings` 按主题分四组、把「档案 / 数据 / 关于」挪去「我的」；「记录」域丢掉自带的 `van-tabs`、今日页拆掉「更多」卡片（入口统一由导航条给）。验收：`tests/navigation-reachability.spec.ts`（路由表 ⇄ 导航树一一对应 / 每页只归一个域 / 写死的跳转都指向存在的路由）、`tests/pages.spec.ts`（每个页面的 tab 高亮 + 导航条 + 面包屑）、`tests/me-page.spec.ts`。口径见 §8.1 |

| T4.8 | **暗色缺陷统一修复 + 导航去重 + 食物库卡片下线 + 报告可删**（2026-10-16） | ✅ 2026-10-16 完成：(1) **颜色只写 token** —— 新增 `--warn-soft` / `--flag-soft` / `--on-danger`，修掉提醒卡片、「待核对」数字、危险按钮三处在深色下的对比度问题，并由 `tests/theme-tokens.spec.ts` 静态守住（页面里再出现颜色字面量就失败）；图表改走 `app/chartTheme.ts` 的两套取值 + `useResolvedTheme()`，连 ECharts 默认的白底提示框一起修。(2) 「记录」域根改为饮食面板 `/log/diet`（旧地址 `/log` 转过来），页头不再并排出现「记录」「饮食」两颗指向同一页的格子，并给 `NavDomain` 加了 `rootLabel`。(3) 「疑似重复」分组卡片下线（理由见 §4.2）。(4) 周报 / 月报可在列表与详情删除（`removeReport`，只做二次确认）。口径见 §4.2 / §8.1 / §8.5 |

---
## 14. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 无后端 → 无法做真正的定时推送 | 提醒可能被无视，覆盖率不升反降 | TD-09：应用内提醒 + 打开时检查 + 系统支持时的本地通知；设置页写清限制，不承诺定时必达 |
| iOS 回收站点数据 | 数据丢失 | 请求持久化存储、迁移前快照、首启与每周提示导出、数据页常驻「上次备份时间」 |
| 模型数值不可靠 | 营养统计失真 | Zod + 范围 + 宏量自洽校验、低置信度需确认、来源留痕、用户值优先 |
| 模型接口兼容性差异 | 功能不可用 | `response_format` 探测式降级、明确错误分类、预留「关闭 JSON 模式改用纯提示词约束」开关 |
| token 成本失控 | 用户放弃使用 | M14 全部策略 + 用量可见 + 预算告警 + 每日上限 |
| 与 Python 脚本口径漂移 | 双入口数据不一致 | §5.3 对拍测试纳入 CI，口径变更必须同时改两边 |
| 单人大包体积（Vant + ECharts） | 首屏变慢 | 按需引入、路由级懒加载、图表组件异步加载；目标首屏 JS ≤ 300KB gzip |
| 结构化导出成为新的事实来源 | 双份真相 | 明确 IndexedDB 为唯一主存储，导出是单向产物（TD-10） |

---

## 15. 附录

### 15.1 契约版本表

| 契约 | 版本 | 变更规则 |
| --- | --- | --- |
| IndexedDB schema | v1 | 每次结构变更 +1，必须带迁移与快照回滚 |
| 导出包 formatVersion | 1 | 不兼容变更 +1；导入需支持最近 2 个版本 |
| LLM 任务契约 | 每任务独立 `version` | 字段增删需 +1，并写入 `llmLogs` 以便追溯 |

### 15.2 依赖清单（预期）

运行时：`vue` `vue-router` `pinia` `dexie` `zod` `dayjs` `echarts` `vant`。
开发期：`vite` `@vitejs/plugin-vue` `vite-plugin-pwa` `typescript` `vitest` `@vue/test-utils` `playwright` `eslint` `prettier`。

### 15.3 与需求文档的对应关系（抽样）

| 需求 | 设计落点 |
| --- | --- |
| FR-404 模型解析结果落库 | §6.3 输出契约 + §6.9 结果缓存 |
| FR-409 / DR-41 请求合并 | §6.3 合并规则（≤10 条/请求） |
| FR-506 汇总不完整提示 | §4.2 `DayRecord.pendingCount` + §9.3 |
| FR-904 校准幅度约束 | §6.7 本地处理 |
| DR-37 模型不得自算数字 | §6.4 数值守卫 + §11 守卫测试 |
| FR-1206 导出可被原脚本消费 | §7.2 工作区文本导出 + §5.3 对拍验证 |
| FR-1305 凭据不导出 | §4.1 对象存储表 + §7.1 导出包规则 |
| FR-1504 离线降级 | §6.10 队列 + §9.3 能力矩阵 |
| FR-110 / FR-208 自由文本录入 | §6.11 `log.parse` 契约 + §8.3-D 交互 |
| FR-111 / FR-1417 图片录入 | §6.11 图片处理规则 + §6.9 图片瘦身 |
| DR-47 澄清优先于估算 | §6.12 澄清引擎 + §11 澄清测试 |
| DR-48 草稿不等于事实 | §6.11 草稿状态 + §8.3-D 确认卡片 |
| FR-1101 提醒范围收窄 | §9.4（已去掉 `.ics`） |
