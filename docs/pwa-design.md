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
| `settings` | `'current'`（单例） | — | 单位、周起始日、外观、提醒、不再追问字段 | ✅ |
| `snapshots` | `id` | `date`, `createdAt` | 本地快照，用于单日回滚（FR-1208） | ✅ |
| `pendingOps` | `id` | `kind`, `status`, `createdAt` | 待补全食物、待生成报告、失败重试（FR-1413 / FR-1504） | ✅（排队项随数据一起走） |
| `llmLogs` | `id` | `createdAt`, `taskId` | 调用日志与 token 估算（FR-1308 / FR-1414） | ❌ 可清空 |
| `modelConfig` | `'current'`（单例） | — | 接口地址、token、模型名等 | ❌ **绝不导出**（FR-1305） |
| `drafts` | `id`（uuid） | `date`, `status` | 自由文本 / 图片解析出的**草稿**：澄清没答完可以当天接着答；草稿不是数据，不参与当日汇总（DR-48 / §6.12） | ✅ |

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

### 4.3 版本与迁移

当前版本 **v2**：v1 是初始表结构；v2 只新增 `drafts`（草稿），既有存储与数据原样保留。
增量的写法是「只声明变化的那张表」，Dexie 会沿用上一版已声明的存储：

```ts
this.version(1).stores({ /* 全部初始表 */ })
this.version(2).stores({ drafts: 'id, date, status' })   // 其余表沿用 v1
```

- Dexie 的 `version(n).stores(...).upgrade(tx => ...)` 处理结构变更；每次变更必须同时提供 `upgrade` 与「导出包兼容说明」。
- 迁移必须在**应用启动、进入界面之前**完成；迁移中显示阻塞式进度，禁止用户中途关闭（避免半迁移状态）。
- 迁移前自动写一次快照（`snapshots`），失败可回滚。
- 迁移代码必须可单测：用上一版的样例数据构造 fixture，断言迁移后数据完整。

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

### 5.3 与脚本对拍（核心质量手段）

`scripts/nutrition.py` 是**验收基准**（需求 §3.3）。做法：

1. 测试 fixture：把仓库现有的 `records/2026-10-09.md` ~ `2026-10-13.md`、`profile.md`、`targets.md` 原样放进 `tests/fixtures/`。
2. 用现有脚本产出期望值：`npm run expected`（`app/scripts/gen-expected.mjs`）。它调用
   `scripts/nutrition.py` 生成 `expected-totals.txt` / `expected-trend.txt` / `expected-tdee.txt` /
   `expected-init.txt`，并在**系统临时目录**里造 21 天合成记录跑一次 `tdee`，得到
   `expected-tdee-synthetic.txt`（仓库真实记录只有 3 天同时有体重与摄入，`tdee` 只能给出「数据不足」，
   覆盖不到反推算法本身）。
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
  maxOutputTokens: number;
  cache?: (input: In, out: Out) => void; // 落库缓存（如食物库）
}
```

首批任务：

| taskId | 用途 | 触发 | 缓存 |
| --- | --- | --- | --- |
| `food.resolve` | 解析库中不存在的食物营养 | 用户确认后（FR-403） | 落 `foods`（FR-404） |
| `report.weekly` | 周报结论与建议 | 用户点生成（FR-701） | 不缓存，可重新生成 |
| `report.monthly` | 月报结论与建议 | 用户点生成（FR-702） | 不缓存 |
| `plan.training` | 今天 / 本周练什么 | 用户点「今天练什么」 | 当日缓存 |
| `plan.meal` | 今天还能吃什么 | 用户点「今天吃什么」 | 当日缓存 |
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

### 6.4 契约二：`report.weekly` / `report.monthly`

两个任务共用同一套契约（`type` 区分），月报只是区间更长、多一段「与上月对比」。**输入是 `domain/reportDigest.ts` 产出的紧凑摘要，不含任何原始记录。**

**输入（周报示例，约 400-600 tokens）**

```json
{
  "period": { "type": "weekly", "label": "2026-W41", "start": "2026-10-05", "end": "2026-10-11", "days": 7 },
  "coverage": { "daysWithIntake": 2, "daysWithWeight": 1, "ratio": 0.29 },
  "intake": { "avgKcal": 2139.6, "target": 2420, "avgProteinG": 95.7, "proteinTargetG": 176,
              "kcalHitDays": 0, "proteinHitDays": 0, "recordedDays": 2 },
  "weight": { "amSeries": [{ "date": "2026-10-11", "kg": 85.8 }], "ma7": 85.8,
              "changeKg": null, "changePctPerWeek": null },
  "training": { "days": 1, "minutes": 45, "sets": 12, "volumeLoadKg": 180,
                "byMuscle": [{ "muscle": "二头", "sets": 6 }, { "muscle": "三头", "sets": 6 }],
                "targetDays": 3, "targetSetsPerMuscle": 10 },
  "currentTargets": { "kcalTarget": 2420, "proteinTargetG": 176, "lastCalibrated": "2026-10-10" },
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

### 6.5 契约三：`plan.training`

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
| 预算告警 | 单次请求估算超过任务预算的 2 倍时，先提示用户「本次请求较大，是否继续」 |

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

### 7.2 工作区文本导出（可回迁）

除结构化导出外，提供「导出为工作区格式」副产物，生成一段可复制的文本 / 可下载的文件集合：

| 文件 | 生成方式 |
| --- | --- |
| `records/YYYY-MM-DD.md` | front-matter + AUTO 汇总区块（由 `domain` 计算生成）+ 摄入表 + 训练表 + 状态与备注 + 待办 |
| `data/foods.csv` | `foods` 表按既有列序导出（`source=llm` 的条目在 `note` 里注明来源与置信度） |
| `profile.md` / `targets.md` | 由单例对象按既有模板生成 |

验收方式：导出后用仓库脚本跑 `python scripts/nutrition.py check --all` 应无错误（FR-1206 / 需求 §13.14）。

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
---

## 8. 界面设计

### 8.1 路由表

| 路由 | 页面 | 备注 |
| --- | --- | --- |
| `/today` | 今日（默认页） | 进度环、缺口提示、快捷录入、队列角标 |
| `/log/:kind?` | 记录（饮食 / 训练 / 身体） | `kind` ∈ `diet\|workout\|body`，缺省 `diet`；顶部子 tab 切换，**日期由这一层统一持有**，切子 tab 不丢日期 |
| `/log/quick` | 一句话 / 拍照记录 | 文本或图片 → 解析草稿 → 逐项确认（FR-110 / FR-111 / FR-113） |
| `/summary/:date?` | 当日汇总 | 不完整时置顶提示 |
| `/trend` | 趋势 | `?days=7\|14\|28` |
| `/reports` / `/reports/:id` | 报告列表 / 详情 | 待生成报告置顶 |
| `/foods` | 食物库 | 来源筛选、疑似重复提示 |
| `/targets` | 目标 | 校准记录表 |
| `/profile` | 档案 | |
| `/plan` | 推荐与周计划 | |
| `/settings` | 设置 | 提醒、单位、外观、不再追问 |
| `/settings/model` | 模型设置 | URL / token / 连通性 / 用量 |
| `/data` | 数据 | 导出、导入、快照、存储占用、队列 |

底部 Tabbar 只保留五个入口：今日、记录、趋势、报告、设置；其余页面从入口页二级进入（避免移动端层级过深）。

底部 Tabbar 的匹配与跳转规则（2026-10-15 修正，见 §13 T1.7）：

- **高亮按前缀分组匹配**：`/log/*` 全部归到「记录」、`/summary` 归到「今日」；匹配不到任何分组时不高亮，但入口仍然可点。
- **跳转一律走点击事件，不用 Tabbar 的 `change`**：`change` 只在选中项**发生变化**时触发，点一个已经高亮的 tab 就成了死键——用户会卡在子页面里回不到首页。
- 由此，「今日」页的方格按钮（记饮食 / 记训练 / 记身体）跳到 `/log/diet|workout|body`，落地在「记录」的对应子 tab，用户随时能点底部「今日」返回。

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
  domain/              纯计算（§5.1），无 IO
  data/
    db.ts              Dexie schema 与版本迁移
    repositories/      days / intake / workout / foods / reports / targets / profile / settings
    seed/              foods.seed.json（由 data/foods.csv 构建期生成）
  llm/
    client.ts          OpenAI 兼容客户端：一次请求、超时、错误分类、baseUrl 归一化、并发 1
    errors.ts          LlmError 分类（重试 / 入队 / 提示三种处置）
    text.ts            剥 ``` 包裹、配平抽取 JSON、token 估算
    types.ts           LlmTask 契约（buildPayload / Zod schema / 输出上限）
    index.ts           runTask 流水线（校验重试、response_format 降级、调用日志）与 probeModel
    tasks/             food.resolve.ts / log.parse.ts（report.* / plan.* / calibration.* 属阶段 3）
  application/         用例层：本地优先、业务校验、落库编排
    foodLibrary.ts     库内查找（精确 + 有限模糊）与「给模型看的名字清单」
    foodResolve.ts     food.resolve 应用层（缓存命中 / 范围与宏量校验 / 去重 / 失败入队）
    logParse.ts        log.parse 应用层（草稿 + 澄清清单 + 失败保原文）
  io/
    markdown/record.ts 记录文件解析（front-matter、章节、表格、组次文本）
    markdown/export.ts 导出回 Markdown（含 AUTO 区块，阶段 4）
    exportPackage.ts   导出包构建与校验
    importPackage.ts   导入与冲突策略
    workspaceExport.ts 工作区文本导出
  ui/
    pages/             今日 / 记录 hub（饮食·训练·身体）/ 当日汇总（其余先占位）
    components/        DateNav 等共享组件
    composables/ charts/  （阶段 3 接入）
  store/               Pinia（会话态与派生态，写操作后统一重算并落库汇总）
tests/
  fixtures/            records / profile / targets 原始文件 + 期望值
  helpers/fixtures.ts  对拍公共工具（容差、期望值解析、fixture → 领域对象）
scripts/
  gen-seed.mjs         从 data/foods.csv 生成 foods.seed.json
  gen-expected.mjs     调用 nutrition.py 生成对拍期望值（含临时目录里的合成 TDEE 样本）
```

构建与质量：`vite build` 产出纯静态 `dist/`；启用 TypeScript strict（含 `noUnusedLocals`）；
提交前跑 `npm run expected`（口径没变时可跳过）与 `npm test`。ESLint + Prettier 尚未接入。

---

## 13. 实施计划

按依赖顺序拆成可独立验收的任务。P0 为「可以开始日常使用」的最小闭环。

> 各任务的**当前状态**、缺口与交接信息见 `docs/pwa-progress.md`；本节只描述任务本身与验收标准。

### 阶段 0：地基

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| T0.1 | 工程脚手架（Vue3 + TS + Vite + Pinia + Router + Vant + Vitest） | ✅ 2026-10-15 完成：`npm test` 19 项通过，`npm run build` 通过（Playwright 留到 E2E 阶段接入） |
| T0.2 | PWA 接入（manifest、SW、图标、安装引导） | ✅ 2026-10-15 完成：manifest/SW/图标已生成并在 preview 下验证可访问（安装引导待接） |
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
| T2.4 | 待办队列 + 离线占位 + 回填回算 | 🟡 2026-10-15：失败已按「等网络 / 需处理」写入 `pendingOps`，未算出的条目以 `pendingFlag` 占位（汇总标「不完整」）；自动补全的执行器（联网后串行重放）待在「数据」页落地 |
| T2.5 | token 用量统计与预算告警 | 🟡 2026-10-15：每次调用写 `llmLogs`（只有估算值与状态，无正文），模型设置页汇总次数 / 失败数 / 输入输出估算并可清空；超出任务预算 2 倍的「是否继续」提示待接 |
| T2.6 | `log.parse` 自由文本解析 + 草稿确认交互 + 澄清追问引擎 | ✅ 2026-10-15：`LogQuickPage.vue` + `store/draft.ts` + `domain/clarify.ts`；草稿存 `drafts` 表，问题按 `<条目>.<字段>` 去重、阻塞项优先、支持「不再追问」名单；`log-parse.spec.ts` / `clarify.spec.ts` / `quick-log-page.spec.ts` 覆盖「任意描述 → 草稿 → 追问 → 落库」与「模型失败也留住原文」 |
| T2.7 | `log.parse.vision` 图片记录（压缩、张数上限、隐私提示、草稿确认） | 🟡 2026-10-15：本地压缩（长边 ≤1024 / JPEG 0.7 / 丢 EXIF）、单次 ≤3 张、发送前提示成本与「图片会发给你配置的模型服务」、请求结束即释放（不落库）均已实现并测到；`unsupported-image` 时提示「当前模型不支持图片输入」的降级分支已分类，UI 引导待补 |

### 阶段 3：报告与推荐（P1）

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| T3.1 | `reportDigest`（本地摘要） | 摘要不含原始记录，字段与契约一致 |
| T3.2 | `report.weekly` / `report.monthly` + 数字守卫 + 数值/文字分区渲染 | 混入臆造数字时被标记 |
| T3.3 | 报告列表、历史版本、重新生成、人工编辑留痕 | 重生成不删除旧版本 |
| T3.4 | `plan.training` / `plan.meal` + 本地复算 | 模型自报营养与本地不一致时以本地为准 |
| T3.5 | `calibration.review` + 校准向导（幅度与频率门禁） | 超出 ±150 kcal 被拦下 |

### 阶段 4：数据治理与打磨（P1-P2）

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| T4.1 | 导出包 / 导入（含三种冲突策略与预览） | 往返一致；导出后 Python `check --all` 通过 |
| T4.2 | 工作区文本导出（records / foods.csv / profile / targets） | 可直接被原脚本消费 |
| T4.3 | 快照与单日回滚 | 回滚后数据与快照一致 |
| T4.4 | 食物库治理（来源筛选、疑似重复、停用） | 被引用的条目不可删除 |
| T4.5 | 提醒方案落地（应用内提醒 + 能力探测的本地通知） | 打开应用能看到当天未完成项；系统支持时按设定时间通知；设置页写明限制 |
| T4.6 | 设置、免责声明、诊断信息导出 | 需求 §9 与 FR-1608 可验 |

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
