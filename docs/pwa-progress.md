# 薄肌计划（PWA）开发进度与交接

> 给**接手继续开发的工程师**：这份文档只讲「现在做到哪一步了、还差什么、下一步从哪下手、哪些坑别再踩一遍」。
> 需求与设计的完整论证在 `docs/pwa-requirements.md` 与 `docs/pwa-design.md`，本文不重复，只给结论和落点。

- 最后更新：2026-10-16
- 应用版本：`0.1.0`（`app/package.json`）
- 分支 / 最近提交：`main` / `af94ef8 feat: 食物库治理（T4.4）：/foods 页 + 来源/分类筛选 + 疑似重复分组 + 停用与删除保护`
- 质量基线（2026-10-16 实测）：`npm test` 49 文件 / 461 项（`npm run build` 随之通过）；**全量并行跑时有两个已知偶发失败**（`quick-log-page.spec.ts` 的草稿断言、`workspace-script.spec.ts` 那条跑 Python 的用例撞 5 秒默认超时），单独重跑即可，见 §8；`workspace-script.spec.ts` 没装 Python 时整组跳过；`npm run build`（含 `vue-tsc -b` 类型检查，**测试文件也在类型检查范围内**）通过

## 0. 三十秒速览

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| 阶段 0 | 地基：脚手架、PWA 接入（含安装引导）、Dexie schema + 仓储层、种子食物库 | ✅ 完成 |
| 阶段 1 | 本地能力闭环：领域计算、三类记录页、当日汇总、趋势页 | ✅ 完成 |
| 阶段 2 | 模型能力：配置与连通性、LLM 客户端、食物补全、自由文本 / 图片记录、澄清引擎、队列执行器 | 🟡 主体完成，2 处收尾未做（见 §3） |
| 阶段 3 | 报告与指导：周报月报、每日指导（A 级）、校准向导、B 级推荐 | 🟡 报告（T3.1 - T3.3）、摘要 v2（T3.6）、每日指导（T3.7，见 §2.10）、校准向导（T3.5，见 §2.11）已完成；**推荐周计划取消**（T3.4），只剩 B 级推荐（T3.8，默认关）未做 |
| 阶段 4 | 数据治理：导入导出、快照回滚、食物库治理、提醒、设置 | 🟡 导出 / 导入（T4.1，见 §2.12）、工作区文本导出（T4.2，见 §2.13）、快照回滚（T4.3，见 §2.14）、食物库治理（T4.4，见 §2.15）与提醒（T4.5，见 §2.16）已完成；设置页的收尾（T4.6：单位 / 外观 / 不再追问 / 免责声明）未做 |

一句话总结：**「配好档案与目标 → 用一句话或表单记一整天（含未知食物自动补全）→ 看当日汇总与趋势 →
每天拿一份带依据的 AI 指导 → 用近 4 周的记录做一次校准 → 生成周报 / 月报」这条链路已经完整**；
推荐周计划已决定不做（B 级生成式推荐默认关、未做）；数据能导出成 JSON 包、也能导回来，
还能导出成原工作区那一套文本（`records/` + `foods.csv` + `profile.md` + `targets.md`，
仓库脚本可直接消费），手滑毁数据有快照可回滚，食物库能自己治理（来源筛选 / 疑似重复 / 停用），
提醒也能用了（今日页的「今天还没记的」清单 + 应用打开时的本地通知），设置页把提醒的限制写清楚了，
只剩设置页的几个开关（单位 / 外观 / 不再追问）与免责声明。

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
- 验收：`npm test` 33 文件 / 321 项、`npm run build` 通过。

**同一轮的第二个决定（2026-10-16）：那些「采集了但没人读」的字段先留着，留给报告用。**
逐项判过了（结论写进 `docs/pwa-design.md` §6.4.1，任务记在 §4.1 的 T3.6）：
睡眠 / 精力 / 酸痛 / RPE / 有氧消耗 / 钠与纤维 / 上一期的数字**确实能让报告变好**，
尤其 —— 输出契约里的 `recovery.notes` 现在完全没有输入支撑；
体脂率、训练年限、作息（起床入睡）、`## 待办`、每日备注原文、`disabledFlag`、设置项**不适合进摘要**
（理由逐条写进设计文档）。所以这一轮**一个字段都没删**，只是把「哪些进摘要、以什么形式进」定下来，等 T3.6 落地。

**第三个决定（2026-10-16，定位回归）：把 AI 指导当成核心能力，分两级。**
用户的定位是「用 AI 记录**并指导**减脂增肌过程」，而实现此前只到"记录 + 周期报告"，
需求文档里的 M8（推荐）、M9（校准建议）、M11（缺口确认）一直是指导型的 —— 是**实现落后于需求**。
于是把 M8 的"不做"改成两级：

- **A 级（做，默认开）诊断型指导**：`coach.daily`（设计 §6.4.2）—— 基于本地摘要指出问题与下一步，
  **不出食谱、不排训练计划**；每条建议必须带 `basis`（NFR-13），沿用报告的数字守卫与样本门禁。
  对应任务 T3.7。
- **B 级（做，默认关）生成式推荐**：原来的 FR-801 ~ FR-808（训练 / 食谱推荐）。
  **必须先恢复忌口 / 过敏 / 可用器材 / 每餐时间四个约束字段才能开启** —— 那两个字段组在档案瘦身时被删过，
  没有它们会出现"推荐了你不能吃的东西"。对应任务 T3.8。

同一轮明确的两条反方意见（都记进需求）：
① 约束字段**暂不恢复**，因为"信息过多会让模型注意力涣散"→ 写成 NFR-14「注意力预算」：
每加一个字段都要能说清它支撑哪条建议；A 级指导不需要约束字段，B 级开启前必须补；
② FR-1602「将要发送的内容可见」从"至少报告类"提升为**所有调用**，并允许单独关掉睡眠 / 精力 / 酸痛。

### 2.10 T3.7 落地：每日指导（A 级）(2026-10-16)

同一批决定的**实现**（§2.9 第三条说要做 A 级指导，这一轮做完了）。

- **新表 `adviceLog`（schema v3）**：一天一条，装 `headline / advice[].basis / focus / ask`、
  模型与契约版本、被守卫标出的数字、被依据校验丢掉的条数、本地闸门提示。
  **手动刷新覆盖当天那一条**（与报告的"重新生成保留旧版本"不同：过期的指导留着只会让"今天看哪一条"变含糊）。
- **本地闸门在 `domain/coach.ts`（纯函数）**：
  - 依据校验（NFR-13）：`resolveBasisPath` 要求路径存在**且有值**（摘要里空值留空，所以样本不足时 `tdee.value` 命不中）；
    命不中的建议整条不展示，并在提示里点名。
  - 样本门禁：覆盖率 < 50% 时 `headline` 前缀「样本不足：」，并去掉 `basis` 落在 `currentTargets.` / `tdee.` 的建议
    （把"不出调整目标类建议"落成可判定的依据前缀，而不是去猜文案里的字眼）。
  - 数字守卫：白名单 = 摘要 v2 + 当日缺口，与报告共用 `buildNumberWhitelistFrom` / `flagUnknownNumbersInTexts`
    （顺手把 `reportGuard.ts` 的收集与扫描抽成了通用实现，报告的对外行为不变）。
  - 缓存指纹：摘要 + 当日缺口的稳定哈希（键序无关）。
- **用例层 `application/coach.ts`**：窗口是**近 7 天滚动**（`period.days` 固定 7，覆盖率分母仍是区间天数）；
  没有目标时 `remainingKcal / remainingProteinG` 留空而不是补 0；`trainedToday` 只有当天全是拉伸时为 false；
  `history.advice` 只带**表过态**的条目、同一句留最近一次、最多 5 条、**不含今天自己那一条**
  （否则点一下"采纳"就把今天的指纹弄脏，页面立刻提示"数据有更新"）。
- **契约 `llm/tasks/coach.ts`**：`coach.daily` v1，输出 `headline / advice[{kind,text,basis}] / focus / ask / disclaimer`，
  6.4.2 的输出形状；`basis` 缺失直接判不合规（走 Zod 重试）。
- **页面 `/coach` + 今日页常驻卡片**：今日页只显示结论与今天的重点（不在这里调模型 —— 生成要花钱，得用户点进去），
  详情页有「将要发送的内容」预览（含 token 估算）、**睡眠 / 精力 / 酸痛三个单独开关**（FR-1602，
  落在 `settings.shareRecovery`，关掉的项连聚合都不参与）、每条建议的依据与"采纳 / 不采纳"、
  数据变了才提示刷新的黄条、以及**任何时候都在**的本地缺口提示（没配模型时的兜底）。
- **迁移**：新表按「每个版本只声明这一版新增的存储」写（v1 全量表 + v2 `drafts` + v3 `adviceLog`）。
  加 v3 时踩到过反例：把第一行写成 `this.version(3).stores({全量表})` 会让 Dexie 把 v2 理解成"只有 drafts"，
  1 → 2 的升级**删掉其余存储**。`db.spec.ts` 的迁移用例当场抓到（见 §8）。
- 验收：`npm test` 36 文件 / 349 项、`npm run build` 通过（两个新用例文件：`coach.spec.ts` 12 项、
  `coach-run.spec.ts` 10 项、`coach-page.spec.ts` 3 项）。

### 2.11 T3.5 落地：校准向导（2026-10-16）

把「校准」从目标页里的一块表单升级成一条独立流程，AI 只负责判断、不负责算数。

- **页面 `/calibration`**（`CalibrationPage.vue`，从目标页顶部常驻卡片进入）分三段：
  **本地数字**（实测 TDEE 与样本、近 4 周均线与变化率、平均摄入与达标率、当前目标、距上次校准）→
  **本地建议**（`proposeCalibration` 的口径，含 ±150 kcal 限幅说明）→ **AI 复核**（方向 / 幅度 / 理由 / 待盯项）。
- **本地数字复用报告的 28 天摘要**（`application/calibration.ts` 调 `domain/reportDigest.buildReportDigest`），
  所以两边给的建议口径一致；覆盖率的分母是 **28 个自然日**（没记录的天也占位），不是"有记录的天数"。
- **三道本地门禁**（`domain/calibrationReview.ts`，纯函数）：TDEE 样本 <7 天 / 覆盖率 <50% / 距上次校准 <14 天 /
  幅度 >±150 kcal —— 任何一条拦下都**把幅度归零、方向置「不变」、不提供「采纳」**；另有两条自洽修正
  （说调整却给 0 幅度 → 当不建议调整；方向与幅度符号不一致 → 以幅度为准）。幅度门禁在**本地再判一次**，
  模型回一个 −400 kcal 也进不了采纳（FR-904 是安全边界，不能靠提示词自觉）。
- **向导不落库**：AI 复核结果只在页面内存里；点「采纳」才 `applyCalibration`（写目标 + 留一行校准记录）
  并回 `/targets`。没配模型 / 模型失败时，本地数字与本地建议照常可用，生成按钮禁用并引导去 `/settings/model`。
- **契约 `llm/tasks/calibration.ts`**：`calibration.review` v1，输出
  `recommended / deltaKcal / direction / confidence / rationale / watchItems`，注册进 `TASKS`。
- 验收：`npm test` 38 文件 / 370 项、`npm run build` 通过（新用例 `calibration-review.spec.ts` 15 项、
  `calibration-page.spec.ts` 3 项；`targets-page.spec.ts` 补一条"任何状态下都能进校准向导"）。
  口径与八条落地约定见设计文档 §6.7 的「实现补充」。

### 2.12 T4.1 落地：导出包 / 导入（2026-10-16）

阶段 4 的第一件事：把「数据只在这台设备的浏览器里」这句话的风险降下来。

- **导出** `io/exportPackage.ts`：单文件 JSON `{ manifest, data, checksum }`。`data` 含记录 / 食物库 /
  报告 / 目标 / 档案 / 设置 / 快照 / 待办 / 草稿 / 指导历史；**不含 `modelConfig` 与 `llmLogs`**
  （FR-1305：token 与调用日志只存本机），也不含 `meta`（本机启动标记）。文件名
  `薄肌计划-export-YYYY-MM-DD.json`，导出后界面给出条目数与校验和。
- **校验和算在规范化 JSON 上**（对象键递归排序）：直接 `JSON.stringify` 会受键序影响 ——
  同一份数据换个键序就得到不同校验和，导入时会把完好的文件判成「被改过」。
- **导入** `io/importPackage.ts` 三步走：`parseExportPackage`（乱 JSON / 不是本应用的文件 /
  `formatVersion` 或 `schemaVersion` 比本机新 / 校验和不符 —— 一律**整包拒绝**）→ `previewImport`
  （新增日期、冲突日期、食物重名、单例是否合并）→ `applyImport`（三种冲突策略 + 导入报告）。
  老包缺 `drafts` / `adviceLog` 时补成空数组、不报错（加字段是加法）。
- **冲突策略**：`skip`（默认，本机不动）/ `merge`（条目按 id 并集，`days` 头部字段逐字段取「文件非空值」
  并留痕）/ `overwrite`（**只覆盖用户显式勾选的日期**，没勾的按跳过）。刻意不用一个大事务包住整包：
  单条不合法只影响那一条、其余继续（FR-1111），代价是可能落下半包 —— 所以每次都给导入报告。
- **单例**（目标 / 档案 / 设置）**绝不整体覆盖**：本机非空的字段优先，只补本机没有的
  （否则会冲掉本机「不再追问」名单）。
- **汇总重算**：文件里的 `summarySnapshot` 一律不采信，导入后按本地口径重算受影响日期
  （`application/daySummary.ts`；`tests/day-summary.spec.ts` 把它的口径与 `store/day.ts` 的 `summary` 钉在一起）。
- **页面 `/data`**（`DataPage.vue`，入口在今日页「更多」）：导出卡片（条目数 + 存储占用 + 校验和）、
  导入卡片（选文件 → 预演 → 选策略 → 确认 → 报告）。
- 验收：`npm test` 42 文件 / 394 项、`npm run build` 通过（新用例 `export-package.spec.ts` 5 项、
  `import-package.spec.ts` 13 项、`day-summary.spec.ts` 2 项、`data-page.spec.ts` 3 项）。
  口径与七条落地约定见设计文档 §7.1 / §7.4 的「实现补充」。

### 2.13 T4.2 落地：工作区文本导出（2026-10-16）

阶段 4 的第二件事：把数据导成**原工作区那一套文本**，让数据不被这个应用锁住（FR-1206）。

- **渲染** `io/markdown/export.ts`（纯转换，不碰 Dexie）：
  - `renderRecordFile` → `records/YYYY-MM-DD.md`：front-matter（`date` / `weekday` / 体重 / 睡眠 / 精力 / 酸痛）
    + `## 摄入` + `## 训练` + `## 状态与备注` + `## 待办` + `AUTO:SUMMARY` 区块；
  - `renderFoodsCsv` → `data/foods.csv`（与 `gen-seed.mjs` 同一套列名，`source=llm` 的条目在 note 里注明来源与置信度）；
    `renderProfileFile` / `renderTargetsFile` 按既有 front-matter 键名生成；
  - `summaryBlockLines` 就是 AUTO 区块的正文，规则逐字对齐脚本的 `summary_lines`（口径仍全在本地，DR-45）。
- **编排** `io/workspaceExport.ts`：读 `days` / `intake` / `workout` / `foods` / `profile` / `targets`，
  日期取三张表的并集（只记了一餐、还没建 `days` 行的那天不该消失），行序按**内容**排
  （摄入「餐次 → 菜品 → 食材」、训练「时间 → 动作」）—— `id` 只有毫秒时间戳加随机后缀，
  同毫秒落库的两条顺序随机，按主键排会让同一份数据导出成不同的文件。
- **交互** `/data` 的「导出为工作区格式」卡片：打包成**一个** `.md` 文本包（每个文件前一行
  `<!-- thin-muscle-workspace: <相对路径> -->`，`splitWorkspaceBundle` 是它的逆运算），
  给出文件名、天数 / 食物数 / 总行数与包内文件清单。不用 zip 的理由与 §7.1 相同。
- **AUTO 区块的位置**：固定在 `## 待办` 之后。正文按 `##` 切段，区块因此落在「待办」段里
  （`parseTodos` 只认 `- [ ]` / `- [x]` 行，不会被区块里的表格污染）；若让区块跟着备注段，
  整段（含表格）会被 `parseRecord` 当备注读回来。
- **顺手修掉一处口径漂移**：`domain/format.ts` 的 `fmtNumber` 原来用 `toFixed`（逢半进位），
  而 Python 的 `'%.1f'` 逢半取偶 —— RPE 均值 7.25 我们写 7.3、脚本写 7.2，AUTO 区块当场对不上。
  已改成精确十进制展开后的逢半取偶（3120 个样本逐一比对两边输出一致）；`docs/pwa-design.md` §5.2 补了这一行。
- 验收：`npm test` 44 文件 / 406 项、`npm run build` 通过。新用例 `workspace-export.spec.ts` 8 项
  （导出 → `parseRecord` 逐项往返、训练日的组次重量与容量负荷、AUTO 区块位置、CSV 转义、
  文本包往返、统计口径）、`workspace-script.spec.ts` 3 项（把导出结果摊进临时工作区，
  **真跑** `python scripts/nutrition.py check --all` 报 0 个问题；逐日比对我们写的与脚本 `totals --write`
  写的 AUTO 区块；导出的 `foods.csv` 能被 `lookup` 认出来 —— 没装 Python 的环境整组跳过）、
  `data-page.spec.ts` 补 1 项。口径与八条落地约定见设计文档 §7.2 的「实现补充」。

### 2.14 T4.3 落地：快照与单日回滚（2026-10-16）

阶段 4 的第三件事：给「手滑毁数据」兜一张网（FR-1208）。`snapshots` 表从 schema v1 就建了，
一直没人用过（上一版 §4.2 的表格里还写着「已建但完全没用过」）。

- **仓储** `data/repositories/snapshots.ts`：`saveSnapshot` / `getSnapshot` / `listSnapshots`
  （最新在前，在内存里排 —— `createdAt` 不是索引）/ `listSnapshotsByDate` / `latestSnapshotForDate`
  / `removeSnapshot` / `pruneSnapshots`。上限 `SNAPSHOT_KEEP = 100`，写入后顺手清理。
- **载荷** `io/snapshot.ts`：本应用自己的 JSON（`formatVersion` / `scope: 'day'` / `date` /
  `takenAt` / 可选 `day` / `intake` / `workout`），**领域对象原样存**，回滚时连 `pendingFlag`、
  `summarySnapshot` 这类派生字段都不丢。读回来走**手写结构检查**（刻意不用 Zod：Zod 会剥掉 schema
  之外的键，剥掉就等于回滚静默丢字段 —— 与导入包同一条理由）。`snapshotContentKey` 是「内容指纹」，
  只看数据、不含 `takenAt`。
- **编排** `application/snapshot.ts`：
  - `captureDay(date, reason)`：拍一张；内容与同一天上一条完全一致时**不重复写**（返回 `deduped`）；
  - `restoreDaySnapshot(id)`：先给「当前状态」自动拍一张（报告里给 `backupId`，所以回滚也能再回滚），
    再在**一个事务**里整天替换（删这一天三张表 → 写回快照内容），最后 `ensureDay` + 按本地口径重算汇总；
  - 坏快照 / 格式版本比本应用新的快照**整条拒绝**，一个字节都不改（连备份都不拍，免得坏快照挤掉真的安全网）。
- **自动快照挂在两处**：`store/day.ts` 的 `removeIntakeEntry` / `removeWorkoutEntry`（删之前），
  `io/importPackage.ts` 的 `applyImport`（覆盖 / 合并之前，只拍真会被改的日期；「跳过」不拍）。
  两处都写清楚 `reason`，用户在数据页一眼看得出「为什么会有这一条」。
- **界面** `/data` 新增「快照与回滚」卡片：日期选择 + 「拍一张快照」、快照列表（时间 / 理由 /
  饮食训练条数 / 「回滚到这一天」）、回滚报告（回滚后 vs 被替换掉的原状态、备份 id、汇总有没有重算），
  卡片底部写明只留最近 100 条。回滚要先过 `showDialog` 二次确认。
- **顺手修掉一个去重 bug**：`captureDay` 原先用 `previous.payload === payload` 比两段 JSON 做去重，
  而载荷里带 `takenAt`（`Date.now()`）—— 两段 JSON 永远不相等，去重等于没写。改成比内容指纹
  `snapshotContentKey`；`tests/snapshot.spec.ts` 的「连拍两次只留一条」钉住这条。
- 验收：`npm test` 45 文件 / 421 项、`npm run build` 通过。新用例 `snapshot.spec.ts` 14 项
  （内容去重、内容变了各留一张、删条记录前先拍、列表排序与 limit、保留上限、整天还原 + 汇总重算、
  回滚可再回滚、没有头部时补一个、坏快照拒绝、未来版本拒绝、快照不存在、导入前自动快照 ×3），
  `data-page.spec.ts` 补 1 项（拍 → 列表 → 回滚 → 报告；jsdom 里 `showDialog` 需要 mock 掉，
  否则没人点确认框、promise 永远不 resolve）。口径与八条落地约定见设计文档 §4.3 的「实现补充」。

### 2.15 T4.4 落地：食物库治理（2026-10-16）

阶段 4 的第四件事：让食物库能自己收拾干净（FR-402 / FR-408 / FR-411 / FR-412）。`/foods` 之前是
占位页，现在有真页面了。

- **本地判定** `domain/foodAudit.ts`：`groupSuspectedDuplicates`（按**去括号后的主名**归一化分组，
  ≥2 条成一组）、`sameFoodFacts`（六项数值是否完全一致 → 组里再分「数值完全相同 / 数值不同」）。
  刻意**不自动合并**：括号里的生熟 / 全脂脱脂往往正是区别，自动挑一条留下就是静默改数值。
  名称工具 `baseNameOf` / `parenOf` 顺手从 `application/foodLibrary.ts` 挪进 `domain/foodName.ts`
  （纯字符串运算，治理页也要用）。
- **用例层** `application/foodAdmin.ts`：`buildFoodOverview`（条目 + 引用数 + 分组 + 统计一次算好）、
  `setDisabled`、`deleteFood`。**「被引用的条目不可删除」落在这一层**（`deleteFood` 走 `foodId`
  索引再查一次引用数，>0 就拒绝并说出几条记录）—— 界面把按钮禁掉只是顺手，绕不过这里；
  再查一次是因为从渲染列表到用户点确认之间可能又记了一条。
- **仓储**：`data/repositories/foods.ts` 加 `setFoodDisabled` / `removeFood`；
  `data/repositories/intake.ts` 加 `tallyIntakeByFood`（治理页一次全表汇总，避免上百次 `count()`）
  与 `countIntakeByFood`（删除判据）。
- **页面** `/foods`：概况（共几条 / 内置·模型·手工 / 已停用 / 被引用过）、按名称搜 + 来源筛选
  （内置 / 模型 / 手工 / **已停用**）+ 分类筛选、疑似重复卡片（每组列出成员、标出数值是否一致、
  说明该「留一条停用其余」还是「先看清括号里的限定语」）、条目列表（六项数值 / 来源说明 / 引用数 /
  停用↔恢复 / 删除，删除按钮在被引用时禁用并写明原因），超过 30 条按需展开。
- **停用的语义**（写进界面文案，别让用户以为数据没了）：只让条目**不再出现在检索与新增候选里**，
  数值与历史记录一字不动 —— 摄入条目存的是 `foodSnapshot` 快照（DR-02）。
- 验收：`npm test` 47 文件 / 435 项、`npm run build` 通过。新用例 `food-admin.spec.ts` 9 项
  （分组与数值一致判定、宽松键 vs 精确键、概况统计、真实种子库 114 条也能分组、停用后检索不到但历史还在、
  停用不存在条目返回原因、被引用删除被拒且条目还在、没引用可删、停用不破坏分组）、
  `foods-page.spec.ts` 5 项（概况与疑似重复卡片、搜索过滤、被引用条目删除按钮禁用、停用后在「已停用」
  里能恢复、没引用过的确认后真删）。口径与八条落地约定见设计文档 §4.2 的「实现补充」。

> 仍未做：**FR-406 的「用户编辑 / 覆盖条目数值」**（含 DR-06 的来源替换）。治理页现在只能停用与删除。
> 近似重复的自动合并属需求 §12 的 P2，不在这一轮。

### 2.16 T4.5 落地：提醒（2026-10-16）

阶段 4 的第五件事：把 M11 的提醒做出来（FR-1101 / FR-1102 / FR-1104 / FR-1105），并且
**如实说明它做不到什么**（TD-09）。`/settings` 从占位页变成真页面，`PlaceholderPage.vue` 随之退休。

- **判定是纯函数** `domain/reminders.ts`：`pendingReminders`（今天还没完成的事）+ `dueReminders`
  （再过一道「已到设定时间」）、`factsFor`（把「哪一天 + 现在几点 + 今天有哪些数据」拼成事实）、
  `mergeReminders`（按 id 补齐默认项）、`reminderHint` / `reminderTarget`（每项怎么补、去哪儿补）。
  五项与默认时间只有一份定义（`REMINDER_DEFAULTS`），`data/repositories/settings.ts` 的 `defaultSettings()`
  直接用它，不再各写一套；老数据缺的项在 `getSettings()` 里按 id 补齐（**只读时补、不写库**）。
- **事实来自库** `application/reminders.ts` 的 `buildReminderState`：一次查 settings / day / intake / reports，
  算出「有没有晨重 / 睡前重 / 摄入 / 本周周报 / 本月月报」。应用内提醒与系统通知**共用这一份事实**，
  不会出现「卡片说还没称重、通知说你已经称过」。周报口径仍用 `periodOf('weekly', date)`（按周一起算），
  只有「哪一天算这一周的最后一天」看 `settings.weekStart`。
- **本地通知** `application/notify.ts`：`notificationSupport()`（每次实时读 `Notification.permission`，
  用户去浏览器设置里改回来立刻生效）、`requestNotificationPermission()`、`runReminderTick()`（弹一条并记
  「今天通知过」）、`startReminderLoop()`（应用打开期间每分钟一次 + `visibilitychange` 回前台补一次）。
  **一天只弹一次**记在 `meta.reminderNotified`（本机状态，不进导出包）；没授权 / 不支持 → 整条链路静默跳过。
- **页面** `/settings`（`pages/SettingsPage.vue`）：五项提醒的开关与时间（改一下就存，没有保存按钮）、
  权限状态与申请按钮、**限制说明**（没有服务端 → 应用关着不响、不提供日历 / .ics 导出、一天只响一次）、
  模型设置入口，以及 T4.6 未做清单（单位 / 外观 / 不再追问 / 免责声明）—— 先把位置与需求编号写好，免得找不到入口。
- **今日页**新增「今天还没记的」卡片：`buildReminderState().pending` + `reminderHint`，每条一个「去补」跳到对应
  记录页（体重 → `/log/body`，摄入 → `/log/diet`，周报月报 → `/reports`）。`App.vue` 挂载时 `startReminderLoop()`、
  卸载时停掉。
- 验收：`npm test` 49 文件 / 461 项、`npm run build` 通过。新用例 `reminders.spec.ts` 17 项（时间解析、
  到点才响、只在这一周 / 本月收尾那天提报告、`weekStart` 影响哪一天算周末、认不出的 id 不臆造语义、
  `mergeReminders` 补默认项、库里有数据就不提醒、上一周的报告不算数、关掉的项两条链路都不出现、
  改过时间按新时间判定、权限四种状态、没授权不弹但应用内照旧、同一天只弹一次、`startReminderLoop`
  立刻检查且能停），`settings-page.spec.ts` 7 项（五项与默认时间、关掉落库、改时间落库、关掉后时间输入禁用、
  限制文案、不支持的按钮禁用、模型设置入口与 T4.6 清单）。口径与五条落地约定见设计文档 §9.4 的「实现补充」。

> 仍未做（T4.6）：单位与周起始日、外观、`mutedFields`（「不再追问」名单）的 UI 入口、免责声明与诊断信息导出。
## 3. 部分完成：有明确缺口（优先补这些）

| 编号 | 已实现 | 缺什么 | 建议落点 |
| --- | --- | --- | --- |
| T2.5 | 每次调用都写 `llmLogs`；模型设置页汇总次数 / 失败数 / 输入输出估算，并可清空 | 单次任务超出预算 2 倍时的「是否继续」确认弹窗 | `app/src/llm/index.ts`（估算是现成的）+ `LogQuickPage` 的交互 |
| 澄清 | `mutedFields`（「不再追问」名单）机制可用 | 没有 UI 入口让用户维护这份名单，目前只能由调用方传入 | `/settings` 页（T4.5 已把提醒做进去，名单入口属 T4.6） |

## 4. 未开始

### 4.1 阶段 3：报告与推荐（P1）

| 任务 | 要做的事 | 依赖 / 注意 | 验收 |
| --- | --- | --- | --- |
| T3.8 | **B 级生成式推荐（可选开关，默认关）** | 需求 M8 第二级：启用前**必须先恢复**忌口 / 过敏 / 可用器材 / 每餐时间四个约束字段（FR-1003 条件生效），否则不得开启 | 开关默认关；开启时约束字段必填且进输入 |

> T3.1 - T3.3（报告摘要 / 周报月报 + 数字守卫 / 报告页）已于 2026-10-15 完成，见 §2.7。
> **T3.4（推荐周计划）已取消**（2026-10-16 范围调整，见 §2.9）。
> **T3.6（摘要 v2）已于 2026-10-16 完成**：`recovery` 块（睡眠 / 精力 / 酸痛，都带"有记录天数"）、
> 训练块补 RPE 均值与 ≥8 条数、有氧估算消耗、饮食块补钠超标天数与纤维达标天数、
> `previousDigest` 带上上一期数字；报告页已显示这些数字。口径与三处有意收窄见设计文档 §6.4.1。
> **T3.7（每日指导 A 级）已于 2026-10-16 完成**，见 §2.10；契约口径与九条落地约定见设计文档 §6.4.2 的「实现补充」。
> **T3.5（校准向导）已于 2026-10-16 完成**，见 §2.11；契约口径见设计文档 §6.7 的「实现补充」。
> 阶段 3 现在只剩 **T3.8 B 级推荐**（默认关、开启前必须先恢复约束字段）。

### 4.2 阶段 4：数据治理与打磨（P1-P2）

| 任务 | 要做的事 | 依赖 / 注意 | 验收 |
| --- | --- | --- | --- |
| T4.6 | `/settings`（提醒、单位、外观、不再追问名单）与 `/data` 剩下的部分（离线队列界面、诊断信息导出）、免责声明 | 需求 §9 要求在应用内展示免责声明；`modelConfig` 已有诊断信息的雏形。**`/data` 的导出 / 导入（T4.1）与快照回滚（T4.3）已经做了** | 需求 §9 与 FR-1608 可验 |
| FR-406（欠账） | 食物条目数值的编辑 / 覆盖（含 DR-06 的来源替换） | M4 的一部分，原计划搭在「食物库」页上，T4.4 只做了来源筛选 / 疑似重复 / 停用与删除保护 | 手工值能覆盖模型值，来源标注跟着变 |

> **T4.1（导出包 / 导入）已于 2026-10-16 完成**，见 §2.12。
> **T4.2（工作区文本导出）已于 2026-10-16 完成**，见 §2.13：「导出后 Python `check --all` 通过」
> 这条验收是它的，由 `tests/workspace-script.spec.ts` 真跑脚本覆盖（T4.1 只做结构化 JSON，
> 验收是「往返一致」，由 `tests/import-package.spec.ts` 覆盖）。
> **T4.3（快照与单日回滚）已于 2026-10-16 完成**，见 §2.14：`snapshots` 表不再是死表，
> 破坏性写操作之前会自动拍一张，`/data` 上能按天回滚，回滚本身也能再回滚。
> **T4.4（食物库治理）已于 2026-10-16 完成**，见 §2.15：`/foods` 从占位页变成真页面，
> 来源 / 分类筛选、疑似重复分组提醒、停用↔恢复、被引用过的条目删不掉（FR-412）。
> **T4.5（提醒）已于 2026-10-16 完成**，见 §2.16：`/settings` 从占位页变成真页面（`PlaceholderPage.vue` 退休），
> 今日页顶部有「今天还没记的」清单，系统支持且已授权时应用打开着会按设定时间弹一条本地通知。
> **T4.6 只做设置页剩下的部分**（它那一行里的「提醒」已经在 T4.5 做完了），之后收尾 T3.8 与 FR-406。

## 5. 代码地图

### 5.1 目录结构（与 `docs/pwa-design.md` §12 对应）

```
app/
  src/
    app/          启动流程（bootstrap：开库 + 写种子）、日期工具、设置、图片压缩
    domain/       纯计算与领域类型 —— 无 IO、不依赖 Vue / Dexie（对拍测试直接打这里）；
                  foodName / foodAudit 是食物库的名称归一化与疑似重复判定；reminders 是提醒的判定、默认时间段与补记入口
    data/         Dexie schema（db.ts）、仓储层（repositories/）、种子数据（seed/）
    llm/          OpenAI 兼容客户端、错误分类、文本抽取、任务注册表与流水线、tasks/
    application/  用例层：本地优先、业务校验、落库编排（foodLibrary / foodResolve / foodAdmin / logParse / queue / report / coach / calibration / snapshot / reminders / notify / daySummary）
    io/           导出包组装（exportPackage）、导入校验 / 预演 / 落库（importPackage）；
                  工作区文本导出（workspaceExport）、日快照载荷与校验（snapshot）；
                  markdown/ 记录文件解析与导出（record / export）
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
| 食物库治理（`/foods`） | `application/foodAdmin.ts` `buildFoodOverview` / `setDisabled` / `deleteFood`；分组在 `domain/foodAudit.ts`，页面是 `pages/FoodsPage.vue` |
| 未知食物落库 | `application/foodResolve.ts` `resolveFoods` / `toFood` |
| 食物名称归一化 / 主名 | `domain/foodName.ts` `normalizeFoodName`（保留括号）/ `baseNameOf` / `looseFoodKey` |
| 自由文本 → 草稿 | `application/logParse.ts` `parseLog` |
| 待办队列重放 | `application/queue.ts` `runQueue`（启动 / 联网时驱动） |
| 报告摘要（模型输入） | `domain/reportDigest.ts` `buildReportDigest` / `periodOf` / `coverageWarning` |
| 报告数字守卫与门禁 | `domain/reportGuard.ts` `flagUnknownNumbers` / `applyCalibrationGate` / `applyCoverageGate` |
| 报告生成与落库 | `application/report.ts` `buildDigest` / `generateReport` / `saveEditedContent` |
| 每日指导（A 级） | `application/coach.ts` `buildCoachContext` / `generateAdvice` / `markAdviceAdopted`；契约在 `llm/tasks/coach.ts` |
| 指导的三道本地闸门 | `domain/coach.ts` `resolveBasisPath` / `applyBasisGate` / `applyCoachCoverageGate` / `flagCoachNumbers` / `coachFingerprint` |
| 指导页面 | `pages/CoachPage.vue`（`/coach`）；今日页的常驻卡片在 `pages/TodayPage.vue` |
| 校准向导（本地数字 + AI 复核） | `application/calibration.ts` `buildCalibrationReviewInput` / `reviewCalibration`；契约在 `llm/tasks/calibration.ts` |
| 校准门禁（样本 / 频率 / 幅度） | `domain/calibrationReview.ts` `applyCalibrationReviewGates` / `flagCalibrationNumbers` / `localProposalOf` |
| 校准页面与入口 | `pages/CalibrationPage.vue`（`/calibration`）；目标页顶部常驻卡片在 `pages/TargetsPage.vue` |
| 落库前拍平响应式对象 | `data/plain.ts` `toPlain`（所有仓储写入都过它） |
| 记录文件解析 | `io/markdown/record.ts` |
| 导出包（JSON） | `io/exportPackage.ts` `buildExportPackage` / `canonicalJson` / `checksumOf` |
| 导入（校验 / 预演 / 落库） | `io/importPackage.ts` `parseExportPackage` / `previewImport` / `applyImport` |
| 不带 Pinia 的当日汇总重算 | `application/daySummary.ts` `buildSummaryForDate` / `recomputeDaySummary` |
| 数据页（导出 / 导入界面） | `pages/DataPage.vue`（`/data`，入口在今日页「更多」） |
| 快照与单日回滚 | `application/snapshot.ts` `captureDay` / `restoreDaySnapshot` / `listSnapshotSummaries`；载荷在 `io/snapshot.ts`，存取与上限在 `data/repositories/snapshots.ts` |
| 导出为工作区文本 | `io/workspaceExport.ts` `buildWorkspaceExport` / `bundleWorkspaceFiles` / `splitWorkspaceBundle`（读库、排序、打包） |
| 工作区文本怎么渲染 | `io/markdown/export.ts` `renderRecordFile` / `renderFoodsCsv` / `renderProfileFile` / `renderTargetsFile` / `summaryBlockLines` |
| 显示数值的舍入 | `domain/format.ts` `fmtNumber`（1 位小数、**逢半取偶**，对齐脚本的 `'%.1f'`） |
| 提醒的判定与默认项（T4.5） | `domain/reminders.ts` `pendingReminders` / `dueReminders` / `factsFor` / `mergeReminders` / `reminderHint` / `reminderTarget` |
| 提醒的事实来源 | `application/reminders.ts` `buildReminderState`（一次查库凑出「今天有哪些数据」） |
| 本地通知与权限 | `application/notify.ts` `notificationSupport` / `requestNotificationPermission` / `runReminderTick` / `startReminderLoop` |
| 设置页与提醒入口 | `pages/SettingsPage.vue`（`/settings`，T4.5）；今日页顶部的提醒卡片在 `pages/TodayPage.vue` |
| 路由表 | `app/src/router/index.ts`（权威表格在 `docs/pwa-design.md` §8.1） |
| 底部 tab 匹配规则 | `app/src/App.vue` 的 `tabs[].match` |

## 6. 环境与常用命令

在 `app/` 目录下：

```bash
npm install
npm run dev       # 本地开发服务器
npm test          # 单元 / 对拍 / 组件测试（49 文件 / 461 项）
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
- **`showDialog` 在 jsdom 里没人点确认，promise 永远不 resolve**（组件测试会挂住）。要测确认后
  的行为，就 `vi.mock('vant', ...)` 只替掉 `showDialog`，其余（`van-button` 等真实组件）原样透传；
  `data-page.spec.ts` 的回滚用例是现成例子。
- **比两段 JSON 来判断「内容有没有变」几乎一定失败**：只要序列化里带 `Date.now()`（快照载荷的
  `takenAt`）就永远不相等。要比就把「内容」单独抽成指纹（`io/snapshot.ts` 的 `snapshotContentKey`）。
- **`npm run build` 会连着类型检查 `tests/`**（`vue-tsc -b` 把测试也纳进项目）：`vitest` 跑得过的
  用例可能在构建时因为 wrapper 类型报错 —— `findAll()` 拿到的是 `DOMWrapper<Element>`、
  `mount()` 给的是 `VueWrapper`，写测试辅助函数时把返回类型标出来（`foods-page.spec.ts` 是例子）。
- **组件测试里点「禁用的按钮」是会真的触发 `@click` 的**：jsdom 不做浏览器的「禁用元素不派发点击」
  那套判断。要验证删除保护，断言 `(btn.element as HTMLButtonElement).disabled === true`，
  不要去点它再看结果。
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
- **全量跑 `npm test` 时，`workspace-script.spec.ts` 里「脚本自己写的 AUTO 区块与我们写的逐字一致」可能撞 5 秒默认超时**
  （2026-10-16 观察：49 个 worker 并行时该用例实测 6.5 秒；单独跑这个文件 8.9 秒内全过）。它**真的**会
  `spawn` Python 去跑 `nutrition.py`，机器忙的时候就会超。看到它失败先单独重跑该文件，别据此判断导出逻辑坏了；
  要根治可以给这一条用例单独放宽 `timeout`。
- **给 Dexie 加版本时，第一行必须是 `this.version(1)` 的全量表**（2026-10-16 真事故，加 `adviceLog` 时踩到）：
  原来第一行是 `this.version(SCHEMA_VERSION).stores({...14 张表})`，`SCHEMA_VERSION` 从 2 改成 3 之后，
  这一行变成了「v3 的全量表」，而后面的 `this.version(2).stores({ drafts })` 就被读成「v2 里只有 drafts 一张表」——
  1 → 2 的升级把 `days` / `intake` / `foods` 等全部删掉，老用户的数据当场蒸发（`db.spec.ts` 的迁移用例抓到：
  `expected undefined to match object { date: '2026-10-01' }`）。写法固定为
  「`version(1)` 全量表 + 之后每版只声明新增的那张表」，不要在 `version(n)` 里写 `SCHEMA_VERSION`。

## 9. 建议的推进顺序

1. ~~T1.6 趋势页 + M9 目标页 + M10 档案页~~ —— 2026-10-15 已完成（见 §2.4），P0 主链路已闭环。
2. ~~T2.4 队列执行器 + T2.7 图片降级引导 + T0.2 安装引导~~ —— 2026-10-15 已完成（见 §2.5）。
3. ~~T3.1 → T3.2 → T3.3~~ —— 2026-10-15 已完成（见 §2.7）。
4. ~~T3.6 摘要 v2~~ → ~~T3.7 每日指导（A 级）~~ —— 2026-10-16 已完成（见 §2.10）。
5. ~~T3.5 校准向导~~ —— 2026-10-16 已完成（见 §2.11）：入口在目标页顶部常驻卡片，页面 `/calibration`，
   数字复用报告的 28 天摘要，三道本地门禁 + 采纳才 `applyCalibration`。（T3.4 推荐已取消，见 §2.9。）
6. ~~T4.1 导出包 / 导入~~ —— 2026-10-16 已完成（见 §2.12）：`/data` 页导出 JSON 包（不含 token 与调用日志）、
   导入走「校验 → 预演 → 三种冲突策略 → 报告」。
7. ~~T4.2 工作区文本导出~~ → ~~T4.3 快照回滚~~ —— 2026-10-16 已完成（T4.2 见 §2.13，T4.3 见 §2.14）：
   对「数据在本地」补齐了最后一条安全带。
8. ~~T4.4 食物库治理~~ —— 2026-10-16 已完成（见 §2.15）：来源 / 分类筛选、疑似重复分组提醒、
   停用↔恢复、被引用过的条目删不掉（FR-412）。
9. ~~T4.5 提醒~~ —— 2026-10-16 已完成（见 §2.16）：`/settings` 真页面（`PlaceholderPage.vue` 退休）、
   今日页「今天还没记的」清单、应用打开时的本地通知（授权后一天只弹一次）。
10. **T4.6 设置页收尾**：单位与周起始日、外观、`mutedFields`（「不再追问」名单）入口、免责声明与诊断信息导出，
   外加 `/data` 的离线队列界面 —— 阶段 4 的最后一件事。**T3.8（B 级推荐）**放最后：它默认关，且开启前必须先
   恢复约束字段。另外还欠一笔 **FR-406**（食物条目数值编辑），见 §4.2 表格里那一行。

每一步都能独立验收；建议每完成一项就更新本文第 2 / 3 / 4 节的表格，以及 `docs/pwa-design.md` §13 的状态标记。

## 10. 交接自检清单

- [ ] `cd app && npm install && npm test`（49 文件 / 461 项；`quick-log-page.spec.ts` 与 `workspace-script.spec.ts`
      偶发失败时重跑一次即可，见 §8）
- [ ] `npm run build` 通过
- [ ] `npm run preview` 能打开今日页，底部 tab 来回切换不卡死
- [ ] 今日页顶部有一次性的「装到主屏幕」提示，点「知道了」后刷新不再出现
- [ ] 今日页「更多」里点「模型设置」能进（**不依赖有没有待补全**）；底部 tab「设置」里也有一个入口
- [ ] 断网记一餐（会出现「待补全」）→ 配好模型 → 回今日页点「立即重试」，条目补齐且角标消失
- [ ] 报告页点「本周」：没配模型时会先生说「数值区已经算好并保存」，配好模型后能进详情页看到数值区 + 文字区
- [ ] 报告详情里模型编出来的数字被高亮成「待核对」；点「重新生成」后列表里有两版
- [ ] 今日页有常驻的「今日指导」卡片 → 进 `/coach` → 没配模型时说明原因并给本地缺口提示
- [ ] `/coach` 点「生成今日指导」：能看到带**依据**的建议与「今天重点」；再点一次会说「数据没变，直接用这一版」（不重复调用）
- [ ] `/coach` 「将要发送的内容」里能看到 JSON（含 token 估算），关掉「睡眠」后 `avgSleepHours` 消失、`sleepDays` 归零
- [ ] 在 `/coach` 给一条建议点「采纳」→ 第二天生成的输入里 `history.advice` 带上它（可在预览里看到）
- [ ] 只记 1-2 天就生成指导：标题带「样本不足」，且没有「调整目标」类建议
- [ ] `/targets` 顶部有常驻的「校准向导」入口（空档案 / 空目标时也在）→ 进 `/calibration` 能看到实测 TDEE、
      近 4 周均线、平均摄入与达标率、当前目标、距上次校准
- [ ] 没配模型时 `/calibration` 不装死：本地数字与本地建议照常，生成按钮禁用并引导去 `/settings/model`
- [ ] 记满 2 周以上再生成校准建议：能看方向 / 幅度 / 理由，点「采纳」后目标更新、校准记录多一行并回 `/targets`
- [ ] 只记几天就生成校准建议：显示「样本不足」等门禁原因，且**没有**「采纳」按钮
- [ ] `/trend` 切 7 / 14 / 28 天，URL 里的 `?days=` 跟着变；空区间显示「未记录」而不是 0
- [ ] `/data` 点「导出工作区文本」：下载到的文本包里能看到 `records/2026-xx-xx.md`、`data/foods.csv`（填过档案 / 校准过还会多出 `profile.md` / `targets.md`）；把记录文件放进工作区跑 `python scripts/nutrition.py check --all` 报 0 个问题
- [ ] `/data` 选日期拍一张快照 → 删掉那天的某条记录 → 点「回滚到这一天」并确认：记录回来，
      报告里同时给出「回滚后」与「被替换掉的原状态」（列表里也会多一条「回滚前自动快照」，能再滚回去）
- [ ] 今日页「更多」→「食物库」：概况数字与库里一致；搜「牛奶」能搜到；点「模型」只留模型条目；
      疑似重复卡片里能看到 `鸡蛋(全蛋 生)` 与 `鸡蛋(水煮)` 并标着「数值完全相同」
- [ ] 食物库里找一条**记过**的食物：删除按钮是禁用的（写着 FR-412）；找一条没记过的：能删掉；
      把某条「停用」后，在记录页的食材检索里搜不到它，切到「已停用」还能恢复
- [ ] 今日页「今天还没记的」卡片里列出晨起称重 / 睡前称重 / 当天摄入还没记完（周末还会多一条「周末生成周报」）；
      点「去补」能落到对应记录页，记完一条回今日页卡片里就少一条
- [ ] 底部 tab「设置」→ 把「晨起称重」关掉：回今日页确认它不在清单里，刷新后仍然是关的；再打开恢复
- [ ] `/settings` 把「晨起称重」的时间改到比现在早一点 → 点「开启系统通知」并允许 → 回今日页（保持应用打开）：
      一分钟内会弹一条「薄肌计划 · 晨起称重」；切到别的 App 再切回来不会再弹同一条
- [ ] `/settings` 的限制说明能看到：没有服务端 → 应用关着不会响；不提供日历 / .ics 导出
- [ ] `/profile` 填一份档案 → `/targets` 用首次估算写入目标，并在「校准记录」里看到一行
- [ ] 在 `/targets` 把热量改掉 200 kcal：确认卡片要出现「超过 ±150 kcal」与「样本可能不足」提示
- [ ] 在 `/settings/model` 填入自己的 OpenAI 兼容接口，连通性测试通过
- [ ] `/log/quick` 用一句话记一餐（无模型时会走占位 + 排队，不报错）
- [ ] 读完本文 §7「变更纪律」，再开始动手
