# 薄肌计划（PWA）开发进度与交接

> 给**接手继续开发的工程师**：这份文档只讲「现在做到哪一步了、还差什么、下一步从哪下手、哪些坑别再踩一遍」。
> 需求与设计的完整论证在 `docs/pwa-requirements.md` 与 `docs/pwa-design.md`，本文不重复，只给结论和落点。

- 最后更新：2026-10-15
- 应用版本：`0.1.0`（`app/package.json`）
- 分支 / 最近提交：`main` / `e84ffc8 feat: 趋势页 + 目标页 + 档案页（P0 主链路闭环）`
- 质量基线（2026-10-15 实测）：`npm test` 24 文件 / 228 项（**有 1 个偶发失败的用例，7 次重跑里出现 3 次，见 §8**）；`npm run build`（含 `vue-tsc -b` 类型检查）通过

## 0. 三十秒速览

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| 阶段 0 | 地基：脚手架、PWA 接入、Dexie schema + 仓储层、种子食物库 | ✅ 完成 |
| 阶段 1 | 本地能力闭环：领域计算、三类记录页、当日汇总、趋势页 | ✅ 完成 |
| 阶段 2 | 模型能力：配置与连通性、LLM 客户端、食物补全、自由文本 / 图片记录、澄清引擎 | 🟡 主体完成，4 处收尾未做（见 §3） |
| 阶段 3 | 报告与推荐：周报月报、推荐周计划、校准向导 | ⬜ 未开始 |
| 阶段 4 | 数据治理：导入导出、快照回滚、食物库治理、提醒、设置 | ⬜ 未开始 |

一句话总结：**「配好档案与目标 → 用一句话或表单记一整天（含未知食物自动补全）→ 看当日汇总与趋势」这条 P0 主链路已经完整；
报告、推荐、导入导出还没有。**

## 1. 文档地图

| 文档 | 什么时候读 |
| --- | --- |
| `docs/pwa-progress.md`（本文） | 接手时先读，了解状态与缺口 |
| `docs/pwa-requirements.md` | 想知道「为什么要这么做」：产品范围、领域口径、功能需求编号 `FR-xxxx` |
| `docs/pwa-design.md` | 动手前必读：架构、数据层、LLM 契约、界面设计；**§13 是任务清单的权威来源** |
| `app/README.md` | 本地跑起来的命令、与 `scripts/nutrition.py` 对拍的原理 |
| `README.md`（仓库根） | 原工作区的 Markdown 格式契约 —— 阶段 4 的导入导出必须兼容它 |
| `AGENTS.md` | 仓库硬性约束（不写绝对路径、`records/` 是唯一事实来源等） |

## 2. 已完成且可验收

### 2.1 阶段 0：地基（T0.1 - T0.4）

- **工程脚手架**：Vue 3 + TypeScript + Vite + Pinia + Vue Router + Vant + Vitest。
  落点 `app/package.json`、`app/vite.config.ts`、`app/tsconfig*.json`。验收：`npm test` / `npm run build` 均通过。
- **PWA 接入**：manifest（名称「薄肌计划」、`start_url: /today`、`display: standalone`、maskable 图标）、
  由 `vite-plugin-pwa` 生成的 Service Worker（`registerType: autoUpdate`）、192 / 512 / maskable / apple-touch 四个图标。
  落点 `app/vite.config.ts`（`VitePWA` 块）、`app/public/icons/`、`app/scripts/gen-icons.mjs`。
  **缺口**：安装引导 UI（「添加到主屏幕」提示）未接，见 §3。
- **Dexie schema + 迁移框架 + 仓储层**：`app/src/data/db.ts` 声明 **15 个对象存储**
  （`days` / `intake` / `workout` / `foods` / `reports` / `targets` / `calibrations` / `profile` /
  `settings` / `snapshots` / `pendingOps` / `llmLogs` / `modelConfig` / `drafts` / `meta`），
  当前 `SCHEMA_VERSION = 2`（v2 只新增 `drafts`，v1 存储沿用）。
  仓储在 `app/src/data/repositories/`（14 个模块，每个一份 CRUD + 索引查询）。
  验收：`app/tests/db.spec.ts` 覆盖索引、幂等写入、校准留痕、队列，以及 v1 → v2 迁移。
  注意：**IndexedDB 不接受布尔值作为索引键**，所有布尔语义字段一律用 0/1 Flag（`disabledFlag`、`pendingFlag` 等）。
- **种子食物库**：`npm run seed` 从 `../data/foods.csv` 生成 `app/src/data/seed/foods.seed.ts`（114 条），
  首次启动幂等写入 `foods` 表，来源标记为内置。落点 `app/scripts/gen-seed.mjs`、`app/src/app/bootstrap.ts`。

### 2.2 阶段 1：本地能力闭环

- **确定性计算全部在 `app/src/domain/`，纯函数、无 IO、不依赖 Vue / Dexie**：
  - `portion.ts` 份量解析与折算（`1个`、`50g`、`一碗` 等 → 克数）
  - `nutrition.ts` 营养换算、求和、宏量 kcal 自洽校验（Atwater）
  - `targets.ts` 目标对比、当日汇总行、缺口提示文案
  - `training.ts` 容量负荷（组 × 次 × 重量，自重不计）、默认 MET 表与有氧消耗
  - `weight.ts` 体重序列、7 日移动平均、夜间净流失、变化率
  - `adherence.ts` 达标率；`tdee.ts` TDEE 反推（Theil-Sen + 最小二乘兜底、50 kcal 取整）；`calibration.ts` 首次目标估算与校准幅度门禁
  - `format.ts` / `foodName.ts`（归一化、生熟推断、酒精识别）/ `clarify.ts`（澄清引擎）
- **对拍质量手段**：`npm run expected` 调用 `../scripts/nutrition.py` 生成期望值，
  `npm test` 用同一批 fixture 喂给 `domain/` 逐项比对。
  落点 `app/tests/fixtures-*.spec.ts`、`app/tests/fixtures/expected-*.txt`、`app/tests/helpers/fixtures.ts`。
  覆盖 `totals` / `trend` / `tdee` / `init`，另有一份 21 天合成样本补足真实记录喂不到的 TDEE 分支。
- **记录页**：`app/src/pages/LogHubPage.vue` 是「记录」容器，顶部子 tab 切换
  `LogDietPage` / `LogWorkoutPage` / `LogBodyPage`；**日期由 hub 统一持有**，切子 tab 不丢日期。
  路由 `/log/:kind(diet|workout|body)?`，缺省 `diet`。状态在 `app/src/store/day.ts`，
  写操作后统一重算并落库汇总。验收：`app/tests/day-store.spec.ts`（真机「60 秒记一餐」待人工验收）。
- **当日汇总页**：`app/src/pages/SummaryPage.vue`，占比列、缺口提示、不完整标记；
  文案与阈值全部复用 `domain/`，与脚本输出同源。
- **导航修正（T1.7，2026-10-15）**：底部 tab 高亮按**前缀分组**匹配（`/log/*` → 「记录」、`/summary` → 「今日」），
  跳转一律走 `@click` 而非 Vant Tabbar 的 `change`（`change` 只在选中项变化时触发，点已高亮的 tab 会变成死键）。
  落点 `app/src/App.vue`。回归用例 `app/tests/pages.spec.ts` 含「点已高亮的 tab 仍能跳转」。

### 2.3 阶段 2：模型能力（主体）

- **模型配置**（`app/src/pages/ModelSettingsPage.vue`）：自填 Base URL / token / 模型名 / 超时，
  一键 `probeModel` 测连通性，并顺手探测接口是否支持 `response_format=json_object` 并记住结论。
  **token 只存本机**：不进导出包、不写日志。验收 `app/tests/model-settings-page.spec.ts`。
- **LLM 客户端**（`app/src/llm/`）：
  - `client.ts`：`normalizeBaseUrl`（填 `.../chat/completions` 也认）、`chatCompletionsUrl`、
    一次请求 + 超时、**并发上限 1**、图片 token 估算。
  - `errors.ts`：错误分类（401 / 404 / 429 / 5xx / 超时 / 非 JSON / 空内容 / 不支持图片），
    分别映射到「重试 / 入队 / 提示」三种处置。
  - `text.ts`：剥 ``` 包裹、配平抽取 JSON、token 估算。
  - `index.ts`：`runTask` 流水线 —— Zod 校验失败重试一次、`response_format` 降级并写备忘录、
    每次调用写 `llmLogs`（只记估算 token 与状态，无正文）；`probeModel` 连通性探测。
    任务注册表 `TASKS` 集中声明每个任务的输入构造、输出 schema 与 token 上限。
  - `types.ts`：`LlmTask` 契约（`buildPayload` / Zod schema / `outputLimitOf`）。
  验收 `app/tests/llm-client.spec.ts`、`app/tests/llm-run.spec.ts`。
- **`food.resolve` 食物补全**（`app/src/llm/tasks/foodResolve.ts` + `app/src/application/foodResolve.ts`）：
  本地优先 → 库里没有才问模型（一次 ≤10 条）→ 过范围校验 + 宏量自洽校验（酒精豁免）→
  可疑项要用户确认才落库 → 失败自动进 `pendingOps` 队列。
  `application/foodLibrary.ts` 提供精确 + **有限**模糊匹配（括号里带生熟 / 干湿一律不模糊；多候选数值不同就不猜）。
  **记录链路永不被模型阻塞**：未配模型 / 断网时先记占位并排队，汇总标「不完整」。
  验收 `app/tests/food-resolve.spec.ts`。
- **一句话 / 拍照记录**（`app/src/pages/LogQuickPage.vue` + `app/src/store/draft.ts`）：
  任意描述（可带 ≤3 张压缩后的图）→ `log.parse` / `log.parse.vision` 产出草稿 → 澄清追问 → 确认落库。
  草稿存 `drafts` 表；模型失败也**留住用户原文**。
  图片：本地压缩（长边 ≤1024 / JPEG 0.7 / 丢 EXIF）、发送前提示成本与「图片会发给你配置的模型服务」、
  请求结束即释放不落库。**估算不了就逐条问，答「记不清 / 不记」也允许**，算不出的记「待补全」参与后续重算。
  落点 `app/src/app/image.ts`、`app/src/application/logParse.ts`、`app/src/llm/tasks/logParse.ts`。
  验收 `app/tests/log-parse.spec.ts`、`app/tests/quick-log-page.spec.ts`。
- **澄清引擎**（`app/src/domain/clarify.ts`）：问题按 `<条目>.<字段>` 去重、阻塞项（克数 / 时长 / 组次重量）优先、
  支持「不再追问」名单（`mutedFields`）；本地能折算的（如库里登记了「1个 = 50g」）直接填并写明假设。
  验收 `app/tests/clarify.spec.ts`。

### 2.4 阶段 1 收口 + M9 / M10（2026-10-15 补）

- **趋势页（T1.6 / M6 FR-600）**：`app/src/pages/TrendPage.vue` + `app/src/domain/trend.ts`。
  `buildTrend()` 是**纯函数区间聚合**：日表（晨重 / 睡前 / 夜间净流失 / 均线 / 六项摄入 / 训练）、
  覆盖率、体重变化率、达标率、训练明细（肌群组数 + 动作容量）、TDEE 反推输入。
  `?days=7|14|28` 由 `normalizeTrendWindow` 收敛，非法值退回 7。
  验收：`app/tests/trend.spec.ts` 拿 fixture 与 `python scripts/nutrition.py trend --days 14` **逐项对拍**
  （19 项：逐日表、区间小结、训练明细、样本标注），`app/tests/trend-page.spec.ts` 覆盖窗口切换 / 覆盖率 /
  空状态 / 缺目标值 / TDEE 样本不足五个界面分支。
  图表用 `app/src/components/EchartView.vue`（ECharts **SVG 渲染器**，按需 import 图表与组件）。
- **目标页（M9 / FR-900）**：`app/src/pages/TargetsPage.vue`。
  无目标时用 `buildInitialTargets`（BMR × 活动系数 → 阶段调整）做**纯本地**首次估算并预填表单；
  无档案时只给「去填档案」的引导，不硬算。
  有目标时改任何字段都走「确认卡片 → `applyCalibration` + `saveTargets`」，**必留一行校准记录**（FR-903）；
  单次 ±150 kcal 以上、距上次校准 < 2 周都会在确认卡片里显式提示（FR-904 / FR-905）；
  「按实测 TDEE 生成建议」复用 `proposeCalibration` 自动限幅；BMI ≥ 28 时给蛋白口径提示并可一键按 1.6 g/kg 重算（FR-906）。
  验收：`app/tests/targets-page.spec.ts`（8 项，含「取消不写库」「只改非热量字段也留痕」）。
- **档案页（M10 / FR-1000）**：`app/src/pages/ProfilePage.vue`。
  字段与 `profile.md` 一一对应；调味料与器材用勾选（**没勾也要存成 false**，推荐模块才知道「没有」）；
  记录口径约定与「不再追问的字段」都是多行文本，一行一条；界面上不存在库存入口（FR-1005）。
  验收：`app/tests/profile-page.spec.ts`。
- **导航**：`/trend`、`/targets`、`/profile` 三个路由从 `PlaceholderPage` 换成真页面，
  并加进了 `app/tests/pages.spec.ts` 的挂载冒烟清单。

## 3. 部分完成：有明确缺口（优先补这些）

| 编号 | 已实现 | 缺什么 | 建议落点 |
| --- | --- | --- | --- |
| T0.2 | manifest / SW / 图标全部就绪，preview 下可安装 | 「添加到主屏幕」引导 UI；iOS 的安装说明 | `app/src/App.vue` 或 `/settings` 页加一次性提示条 |
| T2.4 | 失败已按「等网络 / 需处理」写入 `pendingOps`；未算出的条目以 `pendingFlag` 占位；今日页有队列角标 | 联网后**自动串行重放**的执行器（目前只能重新触发单次解析） | 新建 `app/src/application/queue.ts`，由 `store` 在网络恢复 / 应用启动时驱动 |
| T2.5 | 每次调用都写 `llmLogs`；模型设置页汇总次数 / 失败数 / 输入输出估算，并可清空 | 单次任务超出预算 2 倍时的「是否继续」确认弹窗 | `app/src/llm/index.ts`（估算是现成的）+ `LogQuickPage` 的交互 |
| T2.7 | 压缩 / 张数上限 / 隐私提示 / 用后即弃均已实现并测到；`unsupported-image` 已分类 | 模型不支持图片时的 **UI 引导文案**（提示改用文字记录，或换个支持视觉的模型） | `app/src/pages/LogQuickPage.vue` 的错误分支 |
| 澄清 | `mutedFields`（「不再追问」名单）机制可用 | 没有 UI 入口让用户维护这份名单，目前只能由调用方传入 | `/settings` 页（该页整体还是占位，见 T4.6） |

## 4. 未开始

### 4.1 阶段 3：报告与推荐（P1）

| 任务 | 要做的事 | 依赖 / 注意 | 验收 |
| --- | --- | --- | --- |
| T3.1 | `reportDigest`：本地摘要（周期、均值、达标率、体重趋势、训练容量、缺口） | 纯本地计算，放 `domain/`；**摘要里不含原始记录逐条文本**（省 token） | 字段与 `docs/pwa-design.md` §6.4 契约一致 |
| T3.2 | `report.weekly` / `report.monthly` + **数字一致性守卫** + 数值 / 文字分区渲染 | 新任务注册进 `llm/index.ts` 的 `TASKS`；守卫规则：模型输出的数字必须在本地摘要里出现过 | 混入臆造数字时被标记出来 |
| T3.3 | 报告列表、历史版本、重新生成、人工编辑留痕 | `reports` 表已有 `id, type, periodStart, status` 索引；路由 `/reports`、`/reports/:id` 需从 `PlaceholderPage` 换成真页面 | 重生成不删除旧版本 |
| T3.4 | `plan.training` / `plan.meal` + 本地复算 | 模型自报营养与本地计算结果冲突时**以本地为准** | 页面 `/plan`；不假定用户手头有什么食材（见 `AGENTS.md`） |
| T3.5 | `calibration.review` + 校准向导（幅度与频率门禁） | `domain/calibration.ts` 的 `MAX_CALIBRATION_KCAL = 150` 已是现成门禁；写 `targets` 必须同时写 `calibrations` 留痕 | 超出 ±150 kcal 被拦下 |

### 4.2 阶段 4：数据治理与打磨（P1-P2）

| 任务 | 要做的事 | 依赖 / 注意 | 验收 |
| --- | --- | --- | --- |
| T4.1 | 导出包 / 导入（三种冲突策略 + 预览） | 落点 `app/src/io/exportPackage.ts`、`io/importPackage.ts`；页面 `/data` | 往返一致；导出后 Python `scripts/nutrition.py check --all` 通过 |
| T4.2 | 工作区文本导出（`records/` / `foods.csv` / `profile.md` / `targets.md`） | `app/src/io/markdown/record.ts` 是**解析**侧，导出侧 `io/markdown/export.ts` 未写；必须生成 `AUTO:SUMMARY` 区块 | 可直接被原脚本消费 |
| T4.3 | 快照与单日回滚 | `snapshots` 表已建但完全没用过 | 回滚后数据与快照一致 |
| T4.4 | 食物库治理（`/foods`）：来源筛选、疑似重复、停用 | `foods` 表已有 `source` / `disabledFlag` 索引，`domain/foodName.ts` 已有归一化可做重复检测 | 被引用的条目不可删除 |
| T4.5 | 提醒：应用内提醒 + 能力探测的本地通知 | 前提约束 TD-09：**无后端、不做 Web Push、不做 .ics / 日历导出**；设置页要写明限制 | 打开应用能看到当天未完成项；系统支持时按设定时间通知 |
| T4.6 | `/settings`（提醒、单位、外观、不再追问名单）与 `/data`（导出导入、快照、存储占用、队列）、免责声明、诊断信息导出 | 需求 §9 要求在应用内展示免责声明；`modelConfig` 已有诊断信息的雏形 | 需求 §9 与 FR-1608 可验 |

## 5. 代码地图

### 5.1 目录结构（与 `docs/pwa-design.md` §12 对应）

```
app/
  src/
    app/          启动流程（bootstrap：开库 + 写种子）、日期工具、设置、图片压缩
    domain/       纯计算与领域类型 —— 无 IO、不依赖 Vue / Dexie（对拍测试直接打这里）
    data/         Dexie schema（db.ts）、仓储层（repositories/）、种子数据（seed/）
    llm/          OpenAI 兼容客户端、错误分类、文本抽取、任务注册表与流水线、tasks/
    application/  用例层：本地优先、业务校验、落库编排（foodLibrary / foodResolve / logParse）
    io/markdown/  记录文件（Markdown）解析 —— 导入与对拍共用
    pages/        页面；components/ 共享组件；router/ 路由；store/ Pinia 会话态
  tests/          单元 / 对拍 / 组件测试（fixtures/ 与 helpers/ 同级）
  scripts/        构建期脚本：gen-seed.mjs / gen-expected.mjs / gen-icons.mjs
```

### 5.2 关键函数索引（接手时按名字搜即可）

| 想改什么 | 从这里下手 |
| --- | --- |
| 份量 / 单位换算 | `domain/portion.ts` `parsePortionInput` / `resolvePortion` |
| 营养换算与求和 | `domain/nutrition.ts` `factsForGrams` / `sumFacts` / `isMacroConsistent` |
| 汇总行与缺口提示文案 | `domain/targets.ts` `buildDaySummary` / `buildHints` |
| 容量负荷 / MET 消耗 | `domain/training.ts` `setVolumeLoad` / `metKcal` / `aggregateWorkouts` |
| 体重均线与变化率 | `domain/weight.ts` `movingAverage` / `weightChange` |
| 区间聚合（趋势页 / 报告摘要） | `domain/trend.ts` `buildTrend` / `normalizeTrendWindow` |
| TDEE 反推 | `domain/tdee.ts` `estimateTdee` / `theilSenSlope` |
| 首次目标估算 / 校准幅度 | `domain/calibration.ts` `buildInitialTargets` / `proposeCalibration` |
| 澄清问题生成 | `domain/clarify.ts` `buildClarifyPlan` / `parseClarifyAnswer` |
| 模型调用主流程 | `llm/index.ts` `runTask`（重试、降级、日志）、`probeModel` |
| HTTP 细节与地址归一化 | `llm/client.ts` `normalizeBaseUrl` / `chatCompletion` |
| 模型返回的脏文本 | `llm/text.ts` `parseJsonFromModel` / `estimateTokens` |
| 任务契约（新增任务时） | `llm/types.ts` `LlmTask`，再注册进 `llm/index.ts` 的 `TASKS` |
| 食物库查找与模糊匹配 | `application/foodLibrary.ts` `findFoodFuzzy` / `suggestKnownFoods` |
| 未知食物落库 | `application/foodResolve.ts` `resolveFoods` / `toFood` |
| 自由文本 → 草稿 | `application/logParse.ts` `parseLog` |
| 记录文件解析 | `io/markdown/record.ts` |
| 路由表 | `app/src/router/index.ts`（权威表格在 `docs/pwa-design.md` §8.1） |
| 底部 tab 匹配规则 | `app/src/App.vue` 的 `tabs[].match` |

## 6. 环境与常用命令

在 `app/` 目录下：

```bash
npm install
npm run dev       # 本地开发服务器
npm test          # 单元 / 对拍 / 组件测试（24 文件 / 228 项）
npm run build     # vue-tsc 类型检查 + 生产构建（产物 dist/）
npm run preview   # 预览构建产物 —— 测 PWA 行为请用这个，不要用 dev
npm run seed      # 从 ../data/foods.csv 重新生成内置食物库种子
npm run expected  # 调用 ../scripts/nutrition.py 重新生成对拍期望值
npm run icons     # 重新生成 PWA 图标
```

打包给测试者（产出的 zip 不入库，`app/.gitignore` 已忽略 `release/`）：

```bash
npm run build
# 打 zip：index.html 必须在压缩包根目录
# Windows：Compress-Archive -Path dist/* -DestinationPath release/thin-muscle-plan-0.1.0-2026-10-15.zip
# macOS / Linux：cd dist && zip -r ../release/thin-muscle-plan-0.1.0-2026-10-15.zip .
```

打包后的产物：`app/release/thin-muscle-plan-0.1.0-2026-10-15.zip`（232 KB）。
静态托管的两条硬要求：**必须支持 SPA 回退**（如 `npx serve -s dist`），**装到手机必须 HTTPS 且部署在域名根路径**
（`vite.config.ts` 里 `scope` / `start_url` 都按 `/` 写死）。

## 7. 变更纪律（改动前必须遵守）

1. **确定性计算一律本地算，禁止交给模型**：换算、汇总、占比、均线、达标率、容量负荷、TDEE 反推全部在 `domain/`。
   模型只负责「把用户的话解析成结构」和「把本地摘要写成文字」。
2. **模型输出必须先解析、再 Zod 校验、后落库**；两次失败不写任何数据，并保留用户原文。
3. **记录链路永不被模型阻塞**：未配模型 / 断网时也要能记，占位 + 排队，汇总标「不完整」。
4. **改了 `app/src/domain/` 的口径，或改了 `io/markdown/` 的解析，必须重跑 `npm run expected`**，
   并同步更新 `docs/pwa-design.md` §5.2。期望值变了说明口径真的变了 —— 先确认那是想要的改动。
5. **不写绝对路径**：与工作区一致，任何文件（代码、文档、测试）里都不出现绝对路径。
6. **文件 LF 行尾、无 BOM**：`.gitattributes` 要求 `*.md text eol=lf`；在 Windows 上写文件时注意别引入 BOM。
7. **不改历史记录**：`records/` 是唯一事实来源，只增量补写；`app/tests/fixtures/` 下的记录是测试副本，可以随测试需要增删。
8. **接口只支持 OpenAI 兼容**（`{baseUrl}/chat/completions`），不做自定义请求模板。
9. **不做日历 / `.ics` 导出**（OQ-8 / TD-09），提醒只保留应用内提醒与本地通知能力探测。
10. **新增页面要同步三处**：`app/src/router/index.ts` 的路由、`app/tests/pages.spec.ts` 的挂载冒烟清单、
    本文 §5.2 的函数索引。有链式 IndexedDB 读取的页面（如目标页）要留一个 `data-ready` 标记给测试用。

## 8. 已知坑（踩过的，别再踩）

- **IndexedDB 不接受布尔值作索引键**，只能用 0/1 Flag。新增布尔语义的索引字段时务必照做。
- **Dexie 迁移只需声明新增的表**：`db.ts` 里 v2 只写了 `drafts`，v1 声明过的存储会自动保留。
- **`vitest` 默认环境是 `node`**（起 jsdom 慢一个数量级）；需要 DOM 的用例在文件**首行**加
  `// @vitest-environment jsdom`。Vant 组件是 ESM + 按需样式，`vite.config.ts` 里配了
  `server.deps.inline: ['vant']`，否则 jsdom 下会报 `Unknown file extension ".css"`。
- **`apply_patch` 在这个 Windows 环境下不能用默认入口**，必须走底层 exe（`--codex-run-as-apply-patch`），
  且 patch 需要以 UTF-8 参数传入；多行 PowerShell 命令也容易被策略拒绝，写文件拆成单行更稳。
- **测试里的辅助函数（如 `config()` 之类）如果忘了接收 patch 参数**，用例传入的覆盖值会被静默忽略，
  症状是「改了代码但测试行为没变」的离奇失败 —— 写测试助手时先确认参数真的透传了。
- **测 PWA 行为要用 `npm run preview`**，`npm run dev` 里 `devOptions.enabled: false`，Service Worker 不参与。
- 模型请求**不做任何缓存**（`workbox.runtimeCaching` 为空数组），改动缓存策略时别把模型请求框进去。
- **ECharts 在 jsdom 里会把 stderr 刷满「getContext 未实现」**：`components/EchartView.vue` 里用
  `canRender`（UA 里含 `jsdom` 就跳过绘图）挡掉，别在测试里去断言图表 DOM —— 断言表格与文字。
  另外渲染器固定 `SVG`（不依赖 canvas），ECharts 6 的 `grid.containLabel` 需要额外特性包，
  所以直接用固定留白（`GRID` 常量）。
- **页面里有「读库 → 再读库」的链式 await 时，`flushPromises()` 挡不住 fake-indexeddb 的宏任务**：
  要么用 `vi.waitFor` 包住断言，要么给页面加 `data-ready` 标记再等它变 true（目标页 / 档案页用的是后者）。
  只在库里断言、不等界面刷新，会出现「库里有值但按钮还没渲染」的假失败。
- **`tests/quick-log-page.spec.ts` 是偶发失败的**（2026-10-15 观察：7 次重跑里 3 次失败，且每次失败的用例不一定是同一个）。
  症状是断言 UI 文案时读到的还是旧内容：用例先用 `vi.waitFor` 等草稿落库，再用**一次** `flushPromises()` 就去读渲染结果，
  在 20 个 worker 并行抢资源时这次等待不够。修法很直接——把断言本身也包进 `vi.waitFor`。
  在此之前：看到它失败先重跑一次，**不要**据此判断自己的改动出了问题。

## 9. 建议的推进顺序

1. ~~T1.6 趋势页 + M9 目标页 + M10 档案页~~ —— 2026-10-15 已完成（见 §2.4），P0 主链路已闭环。
2. **T2.4 队列执行器 + T2.7 图片降级引导 + T0.2 安装引导** —— 都是小改动，但直接影响日常可用性。
3. **T3.1 → T3.2 → T3.3** —— 先有本地摘要，再有周报月报，最后做历史版本；这条顺序能把「数字守卫」一次做对。
   `domain/trend.ts` 的区间聚合已经是 `reportDigest` 的现成底座（报告摘要 = 同一次聚合换个周期标签）。
4. **T3.4 / T3.5** —— 推荐与校准，依赖前面的摘要与校准留痕；校准页与 `calibrations` 链路已经打通，向导只需接模型建议。
5. **T4.1 → T4.2 → T4.3** —— 导入导出与快照是「数据在本地」的安全网，建议在报告功能成型后尽快补上。
6. **T4.4 - T4.6** 收尾打磨。

每一步都能独立验收；建议每完成一项就更新本文第 2 / 3 / 4 节的表格，以及 `docs/pwa-design.md` §13 的状态标记。

## 10. 交接自检清单

- [ ] `cd app && npm install && npm test`（24 文件 / 228 项；单个用例偶发失败时重跑一次即可，见 §8）
- [ ] `npm run build` 通过
- [ ] `npm run preview` 能打开今日页，底部 tab 来回切换不卡死
- [ ] `/trend` 切 7 / 14 / 28 天，URL 里的 `?days=` 跟着变；空区间显示「未记录」而不是 0
- [ ] `/profile` 填一份档案 → `/targets` 用首次估算写入目标，并在「校准记录」里看到一行
- [ ] 在 `/targets` 把热量改掉 200 kcal：确认卡片要出现「超过 ±150 kcal」与「样本可能不足」提示
- [ ] 在 `/settings/model` 填入自己的 OpenAI 兼容接口，连通性测试通过
- [ ] `/log/quick` 用一句话记一餐（无模型时会走占位 + 排队，不报错）
- [ ] 读完本文 §7「变更纪律」，再开始动手
