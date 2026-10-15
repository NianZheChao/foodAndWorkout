# 薄肌计划（PWA）开发进度与交接

> 给**接手继续开发的工程师**：这份文档只讲「现在做到哪一步了、还差什么、下一步从哪下手、哪些坑别再踩一遍」。
> 需求与设计的完整论证在 `docs/pwa-requirements.md` 与 `docs/pwa-design.md`，本文不重复，只给结论和落点。

- 最后更新：2026-10-15
- 应用版本：`0.1.0`（`app/package.json`）
- 分支 / 最近提交：`main` / `5797bc2 feat: 报告摘要 + 周报月报 + 数字守卫 + 报告页（T3.1-T3.3）`
- 质量基线（2026-10-15 实测）：`npm test` 33 文件 / 316 项（**有 1 个偶发失败的用例，7 次重跑里出现 3 次，见 §8**）；`npm run build`（含 `vue-tsc -b` 类型检查）通过

## 0. 三十秒速览

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| 阶段 0 | 地基：脚手架、PWA 接入（含安装引导）、Dexie schema + 仓储层、种子食物库 | ✅ 完成 |
| 阶段 1 | 本地能力闭环：领域计算、三类记录页、当日汇总、趋势页 | ✅ 完成 |
| 阶段 2 | 模型能力：配置与连通性、LLM 客户端、食物补全、自由文本 / 图片记录、澄清引擎、队列执行器 | 🟡 主体完成，2 处收尾未做（见 §3） |
| 阶段 3 | 报告与推荐：周报月报、推荐周计划、校准向导 | 🟡 报告已完成（T3.1 - T3.3）；**推荐不做**（2026-10-16 范围调整），校准向导未做（见 §3） |
| 阶段 4 | 数据治理：导入导出、快照回滚、食物库治理、提醒、设置 | ⬜ 未开始 |

一句话总结：**「配好档案与目标 → 用一句话或表单记一整天（含未知食物自动补全）→ 看当日汇总与趋势 → 生成周报 / 月报」
这条链路已经完整；**推荐功能已决定不做**，校准向导与导入导出还没有。**

## 1. 文档地图

| 文档 | 什么时候读 |
| --- | --- |
| `docs/pwa-progress.md`（本文） | 接手时先读，了解状态与缺口 |
| `docs/pwa-requirements.md` | 想知道「为什么要这么做」：产品范围、领域口径、功能需求编号 `FR-xxxx` |
| `docs/pwa-design.md` | 动手前必读：架构、数据层、LLM 契约、界面设计；**§13 是任务清单的权威来源** |
| `app/README.md` | 本地跑起来的命令、与 `scripts/nutrition.py` 对拍的原理 |
| `README.md`（仓库根） | 仓库里有什么、怎么部署分发、对拍质量手段 |
| `AGENTS.md` | 仓库硬性约束（不写绝对路径、**仓库不含个人数据**、口径变更要重跑对拍等） |

## 2. 已完成且可验收

### 2.1 阶段 0：地基（T0.1 - T0.4）

- **工程脚手架**：Vue 3 + TypeScript + Vite + Pinia + Vue Router + Vant + Vitest。
  落点 `app/package.json`、`app/vite.config.ts`、`app/tsconfig*.json`。验收：`npm test` / `npm run build` 均通过。
- **PWA 接入**：manifest（名称「薄肌计划」、`start_url: /today`、`display: standalone`、maskable 图标）、
  由 `vite-plugin-pwa` 生成的 Service Worker（`registerType: autoUpdate`）、192 / 512 / maskable / apple-touch 四个图标。
  落点 `app/vite.config.ts`（`VitePWA` 块）、`app/public/icons/`、`app/scripts/gen-icons.mjs`。
  安装引导（「添加到主屏幕」提示条）见 §2.5。
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
  **与 DeepSeek 这类实现的兼容（2026-10-15 实配踩坑）**：
  ① 服务端在 `response_format=json_object` 下可能**返回 200 但正文为空**（DeepSeek 的官方要求是提示词里
  必须出现 `json` 字样并给出示例，否则可能只回空白）——现在 `runTask` 遇到空正文会自动去掉
  `response_format` 重试一次，并把 `supportsJsonResponse=false` 记进备忘录；
  ② 三个任务的提示词都改成了含小写 `json`；探活的提示词同理，且 `max_tokens` 从 32 提到 128
  （推理型模型会把预算全花在思考上，正文就空了）；
  ③ 「空正文」的报错现在会区分「被 max_tokens 截断 / 只回了 reasoning_content / 其他」，
  400 会把服务端原话带出来并提示官方模型名（`deepseek-chat` / `deepseek-reasoner`）；
  ④ 模型设置页加了「连不上 / 报错时怎么排查」清单。
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
  字段与「会被读」的那几项对齐（性别 / 年龄 / 身高 / 体重 / 目标 / 训练水平 / 作息 / 记录口径约定）；
  「不再追问的字段」写进 `settings.mutedFields`（澄清引擎读的就是它）；界面上不存在库存入口（FR-1005）。
  **2026-10-16 已瘦身**：删掉「约束与偏好 / 调味料有无 / 可用器材」三张卡片与对应字段，见 §2.9。
  验收：`app/tests/profile-page.spec.ts`。
- **导航**：`/trend`、`/targets`、`/profile` 三个路由从 `PlaceholderPage` 换成真页面，
  并加进了 `app/tests/pages.spec.ts` 的挂载冒烟清单。

### 2.5 阶段 2 收尾 + 安装引导（2026-10-15 补）

- **T2.4 队列执行器**：`app/src/application/queue.ts`。`runQueue()` 在**应用启动**与**网络恢复**（`online` 事件）
  时串行重放 `pendingOps`，也在今日页留了「立即重试」按钮。
  三条自我约束写在文件头：只在结果干净时自动写（可疑值 / 低置信度转「需要处理」，FR-407）；
  重放时不重复入队（否则每次重试都再排一条）；任何一步失败都不抛异常，只更新队列项状态。
  `food.resolve` 的重放按**食物名**找到同名待补全条目，用条目自己的克数回算并清掉 `pendingFlag`；
  缺克数就转「需要处理」而不是猜一个克数。`log.parse` 的重放用草稿里的原文重新解析
  —— 图片按设计不落库，只有图片的草稿只能请用户重拍。
  验收：`app/tests/queue.spec.ts`（11 项，含「未配模型不发请求」「可疑值不回填」「不重复入队」「同一查询只请求一次」）。
- **T2.7 图片降级引导**：`Store` 现在保留失败分类（`draft.errorKind`），`LogQuickPage` 在
  `unsupported-image` 时给两条明确出口：去掉图片改用文字重试、或去模型设置换一个支持视觉的模型。
  验收：`app/tests/quick-log-page.spec.ts` 新增用例。
- **T0.2 安装引导**：`app/src/components/InstallHint.vue`，挂在今日页顶部。
  已装（`display-mode: standalone`）不提示；iOS 写清「分享 → 添加到主屏」（FR-1510）；
  Chromium 抓到 `beforeinstallprompt` 才给「安装」按钮；关掉后记进 localStorage（只存这一条 UI 偏好，TD-08）。
  验收：`app/tests/install-hint.spec.ts`（4 项）。

### 2.6 UI 一轮（2026-10-15 补）

只动样式与导航，**没有碰任何计算口径**（`npm run expected` 后 fixture 零差异）。

- **设计基元收口到 `app/src/style.css`**：颜色 / 圆角 / 阴影 / 间距做成 token，卡片、键值行、
  数字块、进度条、按钮网格、提示列表、表格、空状态全部改成全局类。以前每页各写一份
  （`.actions` / `.hint-list` / `.warn-text` 在五个页面里重复），现在改一处所有页面跟着变。
  卡片不再自带 `margin-bottom`，页面用 `.page`（flex + `gap`）统一排版。
- **Vant 主题桥接**：`html:root` 里覆盖 `--van-primary-color` 等变量，把组件的默认蓝换成品牌绿
  （按钮、tabbar、勾选框、开关、tabs 一起生效）。底部 tab 加了图标（Vant 图标字体是内嵌 base64，离线可用）。
- **`components/AppHeader.vue`**：标题 + 可选副标题 + 返回。**修掉一个真问题**：
  `/targets`、`/profile` 之前只能从趋势页的按钮进去，二级页面全都没有退路；
  现在今日页「更多」里有 当日汇总 / 趋势 / 目标与校准 / 档案 / 食物库 / 数据 六个入口，
  二级页面一律带返回（有历史就 `back()`，直接打开就回今日页）。
- **`components/ChipSelect.vue`**：会换行的标签按钮组，单选 / 多选共用。
  替掉 MET（15 项）、肌群（9 项）、调味料（11 项）、器材（7 项）的横排 checkbox —— 横排在手机上挤成一团，
  也不满足 §8.4 的 44px 触控底线。
- **今日页重排**：热量 / 蛋白 / 钠改成带进度条的进度行（超出变红），晨重与训练收进数字块，
  队列卡片与「更多」入口分开，删掉了过期的「还没有的内容」文案。
- **其它**：食物列表项右侧显示 kcal、选中态加勾与左侧色条；三个记录面板修掉**双重 `.page` 内边距**；
  `.card` 里的 `van-field` 去掉左右内边距，和卡片留白对齐。
- 验收：`app/tests/chip-select.spec.ts`（新增）、`app/tests/pages.spec.ts` 新增「导航可达性」两项
  （今日页六个入口可达、五个二级页都有返回按钮且能回来源页），`app/tests/profile-page.spec.ts` 跟着改成标签选择。

**同一天的回归与修复**：这轮重排今日页时删掉了旧「还没有的内容」卡片，顺手把**模型设置的常驻入口
一起删了** —— 结果只剩「待补全队列」卡片里那个按钮（该卡片只在队列非空时渲染）和「模型不支持图片」
的错误分支，正常状态下全应用进不去模型设置。修复：今日页「更多」里加回常驻入口，`/settings` 占位页
也给出一个入口（占位页现在有一张 `REAL_ENTRIES` 表：整体没做的页面上，已经做好的二级功能必须留一条路）。
补了两层守卫：`app/tests/navigation-reachability.spec.ts`（静态扫描：路由表里每个页面都得有写死的入口，
查「零引用」的孤岛）与 `pages.spec.ts` 里两条 DOM 级用例（**不依赖任何状态**就能从今日页 /
设置页进模型设置 —— 静态扫描看不出「入口藏在条件分支里」这种情况）。

### 2.7 阶段 3 报告（T3.1 - T3.3，2026-10-15 补）

- **T3.1 `domain/reportDigest.ts`**：报告摘要。**直接建在 `domain/trend.ts` 的区间聚合上** ——
  趋势页看得见的数、报告摘要里的数、数字守卫的白名单是同一套（`tests/report-digest.spec.ts` 逐项比对两边）。
  摘要里**没有一条原始记录**：只有周期、覆盖率、均值、达标天数、体重序列、训练聚合、当前目标、TDEE
  （测试里断言序列化后的文本不含任何食物名与餐次）。周期：周报按周一到周日（`isoWeekLabel` 给 `2026-W41` 这种标签），
  月报按自然月；区间会被「到今天为止」截短，未来的日子不算。
  **两处补充了设计文档没写死的口径**：覆盖率的分母是**区间天数**（不是传进来的行数）；
  TDEE 样本不到 7 天就不写进摘要（`MIN_TDEE_POINTS`），免得模型拿 3 天反推出来的 4330 kcal 当事实。
- **T3.2 任务 + 数字守卫**：`llm/tasks/report.ts`（`report.weekly` / `report.monthly` 共用一套输入输出契约，
  `findings[].kind` 由 Zod 枚举强制，缺失就走重试 → 两次不合规不落库）；
  `domain/reportGuard.ts` 三道闸门：**数字守卫**（正文数字必须在摘要里出现过，或 `0-100%` 的百分比形式，
  或天 / 周 / 组这类常量）、**校准幅度门禁**（超出 ±150 kcal 降级成待确认）、**覆盖率门禁**（< 50% 不给校准建议）。
  守卫只标记不改写：待核对的数字照样显示，只是高亮出来。
- **T3.3 报告页**：`app/src/pages/ReportsPage.vue`（`/reports`）+
  `app/src/pages/ReportDetailPage.vue`（`/reports/:id`）。
  列表页给「本周 / 本月」两个生成入口与历史版本（标签写明「待生成文字 / 文字已生成 / 已人工编辑」，
  并标出待核对数字个数）；详情页按 **数值区（本地计算，不可编辑）/ 文字区（模型写，可编辑）** 分区，
  待核对数字就地高亮。**没配模型也能先生成数值区**（`status: pending`），界面会说清「数值已存、文字待生成」。
  「重新生成」永远新建一条记录，旧版本留在列表（FR-710）；人工编辑写 `editedByUser` 留痕。
- 用例：`app/tests/report-digest.spec.ts`（12 项）、`report-guard.spec.ts`（10 项）、
  `report-generate.spec.ts`（8 项，含「模型失败也留数值区」「重生成不动旧版本」）、
  `report-pages.spec.ts`（7 项，覆盖未配模型、样本不足、编辑留痕、重生成）。

### 2.8 仓库转型为纯 app 仓库（2026-10-15）

**这一步只动仓库内容，没有动应用代码的任何口径。**

- **删掉的工作区文件**：`records/`（5 天真实记录）、`profile.md`、`targets.md`、
  `reviews/2026-W41-review.md`、`plans/`、`templates/`、`skills/fatloss-*`、`install-skills.*`。
  这些是「用 Codex 记减脂」那套工作流的文件，与这个 PWA 无关，且含个人数据。
- **保留 `scripts/nutrition.py` 与 `data/foods.csv`**：前者是 `domain/` 的**验收基准**，
  后者是食物库种子与脚本的共同数据源 —— 两者都是 app 的构建 / 验证依赖，不是使用者的私人文件。
- **`app/tests/fixtures/` 换成合成数据**：5 天记录 + 档案 + 目标全部重写（75 kg 那位「合成使用者」），
  但保留同样的结构边界：一天没称重、一天只有睡前重、一天训练、油盐单独成行；
  期望值随之重生成，断言里的硬编码数值（BMR/TDEE/肌群组数/容量等）一并更新。
- **`npm run expected` 改成自包含**：`app/scripts/gen-expected.mjs` 现在把
  `scripts/nutrition.py` + `data/foods.csv` + fixtures 组装进一个**系统临时工作区**再跑脚本，
  不再依赖仓库根的 `records/`、`profile.md`、`targets.md`。
  （踩过的坑：一开始只把脚本复制进临时目录、调用时却写的仓库路径，结果 `__file__` 指回仓库根，
  又读到了真实文件 —— 期望值看起来「没变」，其实是被静默忽略了。）
- **`README.md` / `AGENTS.md` 重写成 app 版**：README 讲清仓库里有什么、怎么部署分发（HTTPS + 根路径 +
  SPA 回退）与对拍质量手段；AGENTS.md 只留应用工程约束，并新增一条硬规矩：**仓库里不能出现真实记录、
  档案与个人身份信息**。
- **还没做的一件事**：**GitHub 上的历史提交里仍然有这些个人数据**（之前 push 过）。
  文件删了不等于历史干净 —— 要彻底清除得重写历史（`git filter-repo` / BFG）再强推，
  那一步需要使用者显式授权（见 §7 第 16 条）。动手前已在仓库外留了一份完整备份
  （含 `.git` 历史）。

### 2.9 范围调整：不做推荐 + 档案瘦身 + 死代码清理（2026-10-16）

**决定**：应用只做「记录 + 本地统计 + 报告 + 校准」，**不做饮食与训练推荐，也不做周计划生成**。
因此把只服务于推荐的输入与代码一并清掉（这次一句口径计算都没动，`npm run expected` 后 fixture 零差异）。

- **档案页**去掉三张卡：约束与偏好（伤病 / 过敏 / 忌口 / 每餐做饭时间 / 每日预算）、调味料有无、
  可用器材；`ProfileRecord` 里对应的 7 个字段与 `mutedFields` 一并删除。
  老数据里残留这些键不影响读取（IndexedDB 允许多余字段）。
- **顺手修掉一个"假功能"**：档案页的「不再追问的字段」原来写进 `profile.mutedFields`，
  而澄清引擎读的是 `settings.mutedFields` —— 那个输入框一直是摆设。现在直接读写设置里那一份，
  并加用例固定住（`profile-page.spec.ts`）。
- **`/plan` 路由删除**（推荐与周计划的占位页），requirements 的 M8 与 design 的 §6.5 / §6.6 标注为历史记录。
- **死代码清理**：用脚本扫出「全仓库零引用」的导出并删除 ——
  `date.isValidIsoDate`、`report.previousReportOf`、`days.listRecentDays`、`drafts.countOpenDrafts`、
  `foods.getFood`、`foodName.inferCookedState`、`nutrition.factsForSnapshot`、`targets.formatSummaryRow`、
  `weight.eveningWeight`、`tests/helpers/fixtures.FIXTURE_DIR_PATH`。
  另有 38 个导出只在自己文件里用（`export` 范围偏大，不算无用），暂不动。
- **顺手治了一个"每天一次的假变更"**：`expected-init.txt` 里带着脚本输出的 `last_calibrated: <今天>`，
  谁跑到第二天再跑 `npm run expected` 都会看到脏文件。现在这行统一写成 `<today>`（没有断言依赖它的具体日期）。
- 验收：`npm test` 33 文件 / 316 项、`npm run build` 通过。

**同一轮的第二个决定（2026-10-16）：那些「采集了但没人读」的字段先留着，留给报告用。**
逐项判过了（结论写进 `docs/pwa-design.md` §6.4.1，任务记在 §4.1 的 T3.6）：
睡眠 / 精力 / 酸痛 / RPE / 有氧消耗 / 钠与纤维 / 上一期的数字**确实能让报告变好**，
尤其 —— 输出契约里的 `recovery.notes` 现在完全没有输入支撑；
体脂率、训练年限、作息（起床入睡）、`## 待办`、每日备注原文、`disabledFlag`、设置项**不适合进摘要**
（理由逐条写进设计文档）。所以这一轮**一个字段都没删**，只是把「哪些进摘要、以什么形式进」定下来，等 T3.6 落地。

## 3. 部分完成：有明确缺口（优先补这些）

| 编号 | 已实现 | 缺什么 | 建议落点 |
| --- | --- | --- | --- |
| T2.5 | 每次调用都写 `llmLogs`；模型设置页汇总次数 / 失败数 / 输入输出估算，并可清空 | 单次任务超出预算 2 倍时的「是否继续」确认弹窗 | `app/src/llm/index.ts`（估算是现成的）+ `LogQuickPage` 的交互 |
| 澄清 | `mutedFields`（「不再追问」名单）机制可用 | 没有 UI 入口让用户维护这份名单，目前只能由调用方传入 | `/settings` 页（该页整体还是占位，见 T4.6） |

## 4. 未开始

### 4.1 阶段 3：报告与推荐（P1）

| 任务 | 要做的事 | 依赖 / 注意 | 验收 |
| --- | --- | --- | --- |
| T3.5 | `calibration.review` + 校准向导（幅度与频率门禁） | `domain/calibration.ts` 的 `MAX_CALIBRATION_KCAL = 150` 已是现成门禁；写 `targets` 必须同时写 `calibrations` 留痕 | 超出 ±150 kcal 被拦下 |
| T3.6 | **报告摘要扩展**：新增 `recovery` 块（睡眠 / 精力 / 酸痛）、训练块补 RPE 与有氧消耗、饮食块补钠与纤维达标、`previousDigest` 带上上一期的数字 | 口径与取舍见 `docs/pwa-design.md` §6.4.1；聚合放 `domain/reportDigest.ts`，组装在 `application/report.ts` 的 `buildDigest()`；数字守卫白名单会自动覆盖新字段 | 摘要在样本稀疏时带上「有记录天数」；报告页能把新增数字显示出来；对拍/单测覆盖 |

> T3.1 - T3.3（报告摘要 / 周报月报 + 数字守卫 / 报告页）已于 2026-10-15 完成，见 §2.7。
> **T3.4（推荐周计划）已取消**（2026-10-16 范围调整，见 §2.9）。

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
    application/  用例层：本地优先、业务校验、落库编排（foodLibrary / foodResolve / logParse / queue / report）
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
| 待办队列重放 | `application/queue.ts` `runQueue`（启动 / 联网时驱动） |
| 报告摘要（模型输入） | `domain/reportDigest.ts` `buildReportDigest` / `periodOf` / `coverageWarning` |
| 报告数字守卫与门禁 | `domain/reportGuard.ts` `flagUnknownNumbers` / `applyCalibrationGate` / `applyCoverageGate` |
| 报告生成与落库 | `application/report.ts` `buildDigest` / `generateReport` / `saveEditedContent` |
| 落库前拍平响应式对象 | `data/plain.ts` `toPlain`（所有仓储写入都过它） |
| 记录文件解析 | `io/markdown/record.ts` |
| 路由表 | `app/src/router/index.ts`（权威表格在 `docs/pwa-design.md` §8.1） |
| 底部 tab 匹配规则 | `app/src/App.vue` 的 `tabs[].match` |

## 6. 环境与常用命令

在 `app/` 目录下：

```bash
npm install
npm run dev       # 本地开发服务器
npm test          # 单元 / 对拍 / 组件测试（33 文件 / 316 项）
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
5. **不写绝对路径**：任何文件（代码、文档、测试）里都不出现绝对路径。
6. **文件 LF 行尾、无 BOM**：`.gitattributes` 要求 `*.md text eol=lf`；在 Windows 上写文件时注意别引入 BOM。
7. **仓库不含个人数据**（2026-10-15 起）：`app/tests/fixtures/` 下的记录与档案必须是**合成数据**，
   新增用例也从合成数据出发；真实记录、档案与目标只存在于使用者设备上，不进仓库、也不写进文档。
8. **接口只支持 OpenAI 兼容**（`{baseUrl}/chat/completions`），不做自定义请求模板。
9. **不做日历 / `.ics` 导出**（OQ-8 / TD-09），提醒只保留应用内提醒与本地通知能力探测。
10. **新增页面要同步三处**：`app/src/router/index.ts` 的路由、`app/tests/pages.spec.ts` 的挂载冒烟清单、
    本文 §5.2 的函数索引。有链式 IndexedDB 读取的页面（如目标页）要留一个 `data-ready` 标记给测试用。
11. **队列重放必须传 `{ enqueueOnFailure: false }`**：`resolveFoods` / `parseLog` 默认在失败时写待办队列，
    重放路径再用默认值就成了「越重试越长」。以后新增可入队的任务，记得同样留一个开关。
12. **队列执行器只自动回填「干净」结果**：可疑值（越界 / 宏量不自洽）与低置信度一律转 `needs-attention`，
    等用户确认（FR-407）。不要为了「自动」而把需要拍板的数值偷偷写进记录。
13. **新页面用 `components/AppHeader.vue` 开头**（标题 + 副标题 + `back`）：底部 tab 只有五个入口，
    二级页面必须自带退路。样式一律用 `style.css` 的全局类，页面 `<style scoped>` 只写这一页特有的东西。
14. **报告的数值区永远本地算、永远不可编辑**：模型只写文字。要改数字就去改记录或走校准流程；
    界面上不给「编辑数值」的入口，避免报告和记录各说各话。
15. **写库前把响应式对象拍平**：界面传下来的对象可能是 Vue 的响应式代理，直接 `put` 会
    `DataCloneError`。这一层**统一收在仓储写入**：`src/data/plain.ts` 的 `toPlain()`，
    所有 `db.*.put/update` 的入参都过一遍。新写仓储时别漏 —— 只做浅拷贝（`{...obj}`）没用，
    里面的数组 / 嵌套对象仍然是 Proxy。回归用例 `app/tests/plain-write.spec.ts`。
16. **不要 `git push --force`**：包括重写历史这类操作，必须由使用者**显式授权**后再做，
    并且动手前先在仓库外留一份完整备份（含 `.git`）。

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
- **jsdom 缺 `matchMedia`、canvas、`beforeinstallprompt`**：用到它们的组件要把「能力探测」写成守卫
  （`InstallHint.vue` 先判 `typeof window.matchMedia === 'function'`，`EchartView.vue` 直接跳过 jsdom），
  否则测试会在与业务无关的地方炸掉。
- **`listOpenOps()` 只返回未完成的队列项**：断言「收口了没有」要看 `db.pendingOps` 的原始行，
  不要写成 `(await listOpenOps())[0].status`（队列清空时是 undefined，报错信息很难懂）。
- **`.card` 不再自带 `margin-bottom`**：页面间距由 `.page` / `.panel` 的 `flex + gap` 负责。
  把卡片塞进一个普通 `<div>` 里就会贴在一起 —— 记录页的三个面板以前各自套了一层 `<section class="page">`，
  结果是 **48px 的双重内边距**，改成 `.panel` 才对。
- **二级入口不要藏在条件分支里**（2026-10-15 真事故）：把「模型设置」的按钮放进
  「待补全队列」卡片（只在队列非空时渲染），正常状态下整个应用就进不去模型设置了。
  入口要么放常驻网格，要么在整体未完成的页面上留一条 `REAL_ENTRIES` 通路。
- **静态扫描查不出「条件渲染的入口」**：`navigation-reachability.spec.ts` 只能发现一个引用都没有的
  孤岛页面；入口是否**真的渲染出来**要靠 DOM 断言（`pages.spec.ts` 里那两条「不依赖任何状态就能进」）。
  加新入口时两层都要想一遍。
- **DeepSeek 的两个坑（2026-10-15 实配）**：① 官方的 JSON 模式要求提示词里出现 `json` 字样
  并给出示例，否则会「200 但正文为空」；② 模型名要填官方名（`deepseek-chat` / `deepseek-reasoner`），
  填了不存在的名字（例如把 Codex 这边的 `deepseek-flash` 抄过去）会 400。
  排查顺序写进了模型设置页的提示卡，别再对着 200 响应猜。
- **`DataCloneError: could not be cloned` = 把 Vue 的响应式代理写进了 IndexedDB**（2026-10-15 真机报错）：
  现场是记录训练时 `muscles.value`（`ref([])` 的 `.value`）一路传到 `db.workout.put`。
  两个容易漏的点：① **浅拷贝没用** —— `{ ...entry }` 只复制一层，里面的 `muscles` / `sets` 仍是 Proxy；
  ② 之前只在报告的 `saveEditedContent` 里做了深拷，等于把同一类 bug 留在了别处。
  现在统一在仓储写入层拍平（`src/data/plain.ts`），`tests/plain-write.spec.ts` 逐条覆盖各写入函数。
- **`tests/quick-log-page.spec.ts` 是偶发失败的**（2026-10-15 观察：7 次重跑里 3 次失败，且每次失败的用例不一定是同一个）。
  症状是断言 UI 文案时读到的还是旧内容：用例先用 `vi.waitFor` 等草稿落库，再用**一次** `flushPromises()` 就去读渲染结果，
  在 20 个 worker 并行抢资源时这次等待不够。修法很直接——把断言本身也包进 `vi.waitFor`。
  在此之前：看到它失败先重跑一次，**不要**据此判断自己的改动出了问题。

## 9. 建议的推进顺序

1. ~~T1.6 趋势页 + M9 目标页 + M10 档案页~~ —— 2026-10-15 已完成（见 §2.4），P0 主链路已闭环。
2. ~~T2.4 队列执行器 + T2.7 图片降级引导 + T0.2 安装引导~~ —— 2026-10-15 已完成（见 §2.5）。
3. ~~T3.1 → T3.2 → T3.3~~ —— 2026-10-15 已完成（见 §2.7）。
4. **T3.5 校准向导** —— 校准页与 `calibrations` 链路已经打通，报告页也已经能给出（并拦住）校准建议，
   向导只需把「采纳建议」接到 `applyCalibration`。`domain/reportDigest.ts` 的 `buildDigest` 可以直接复用。
   （T3.4 推荐已取消，见 §2.9。）
5. **T4.1 → T4.2 → T4.3** —— 导入导出与快照是「数据在本地」的安全网，建议在报告功能成型后尽快补上。
6. **T4.4 - T4.6** 收尾打磨。

每一步都能独立验收；建议每完成一项就更新本文第 2 / 3 / 4 节的表格，以及 `docs/pwa-design.md` §13 的状态标记。

## 10. 交接自检清单

- [ ] `cd app && npm install && npm test`（26 文件 / 245 项；单个用例偶发失败时重跑一次即可，见 §8）
- [ ] `npm run build` 通过
- [ ] `npm run preview` 能打开今日页，底部 tab 来回切换不卡死
- [ ] 今日页顶部有一次性的「装到主屏幕」提示，点「知道了」后刷新不再出现
- [ ] 今日页「更多」里点「模型设置」能进（**不依赖有没有待补全**）；底部 tab「设置」里也有一个入口
- [ ] 断网记一餐（会出现「待补全」）→ 配好模型 → 回今日页点「立即重试」，条目补齐且角标消失
- [ ] 报告页点「本周」：没配模型时会先生说「数值区已经算好并保存」，配好模型后能进详情页看到数值区 + 文字区
- [ ] 报告详情里模型编出来的数字被高亮成「待核对」；点「重新生成」后列表里有两版
- [ ] `/trend` 切 7 / 14 / 28 天，URL 里的 `?days=` 跟着变；空区间显示「未记录」而不是 0
- [ ] `/profile` 填一份档案 → `/targets` 用首次估算写入目标，并在「校准记录」里看到一行
- [ ] 在 `/targets` 把热量改掉 200 kcal：确认卡片要出现「超过 ±150 kcal」与「样本可能不足」提示
- [ ] 在 `/settings/model` 填入自己的 OpenAI 兼容接口，连通性测试通过
- [ ] `/log/quick` 用一句话记一餐（无模型时会走占位 + 排队，不报错）
- [ ] 读完本文 §7「变更纪律」，再开始动手
