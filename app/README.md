# 薄肌计划（PWA）

个人减脂增肌应用的前端工程。**无后端**：记录、食物库、报告与配置全部存放在浏览器 IndexedDB 中；
除用户自己配置的 OpenAI 兼容模型接口外，不向任何第三方发送数据。

- 需求文档：`docs/pwa-requirements.md`
- 设计文档：`docs/pwa-design.md`
- 开发进度与交接：`docs/pwa-progress.md`
- 记录文件格式契约：`docs/pwa-design.md` §7.2（导入 / 导出用同一套 front-matter 与表格列名）

## 快速开始

```bash
npm install
npm run seed     # 从 ../data/foods.csv 重新生成内置食物库种子
npm run expected # 调用 ../scripts/nutrition.py 重新生成对拍期望值
npm run icons    # 重新生成 PWA 图标
npm run dev      # 本地开发
npm test         # 单元测试
npm run build    # 类型检查 + 生产构建（产物在 dist/）
npm run preview  # 预览构建产物
npm run deploy   # 构建（Pages 的 base）+ 推到部署仓库，见根 README「部署与分发」
```

`npm run deploy` 的细节（子路径 base、`.nojekyll` 与 `404.html`、部署仓库与回滚）见根 `README.md`
的「部署与分发」，以及 `scripts/deploy-pages.mjs` 的文件头注释。

## 与脚本对拍（核心质量手段）

`../scripts/nutrition.py` 是计算口径的**验收基准**。`npm run expected` 会把脚本的输出
（`totals` / `trend` / `tdee` / `init`，外加一份在系统临时目录里造的 21 天合成样本，用来覆盖
fixtures 喂不到的 TDEE 反推）写到 `tests/fixtures/expected-*.txt`；`npm test` 再拿同一批 fixture
喂给 `io/markdown` + `domain/`，与期望值逐项比对。

脚本与 `../data/foods.csv` 会被临时复制成一个**自包含的工作区**再运行，`tests/fixtures/` 下的
记录与档案都是合成数据 —— 这个仓库里没有任何使用者的真实数据。

因此：**改了 `src/domain/` 的口径，或改了记录文件格式的解析，就要重跑 `npm run expected`。**
期望值变了说明口径真的变了——先确认那是想要的改动，再同步更新 `docs/pwa-design.md` §5.2。

## 目录结构

```
src/
  app/          启动流程（打开数据库、写入种子食物库）与日期工具
  domain/       纯计算与领域类型（无 IO、不依赖 Vue / Dexie）
  data/         Dexie schema、仓储层、种子数据
  io/markdown/  记录文件（Markdown）解析，导入与对拍共用
  store/        Pinia 会话状态（写操作后统一重算并落库汇总）
  pages/        页面
  router/       路由
tests/          单元 / 对拍 / 组件测试（fixtures 与 helpers 在同级目录）
scripts/        构建期脚本（种子、图标、对拍期望值）
```

## 已实现（阶段 1）

- 页面：今日仪表盘、记饮食、记训练、记身体、当日汇总
- 计算：份量折算、营养换算、目标对比与缺口提示、容量负荷、MET 消耗、体重均线与变化率、
  达标率、TDEE 反推、首次估算——全部本地确定性计算，不交给模型
- 质量：与 `nutrition.py` 的逐项对拍测试（`tests/fixtures-*.spec.ts`）

## 已实现（阶段 2 · 模型能力）

- 模型设置：自己填 OpenAI 兼容接口的 Base URL / token / 模型名与超时，一键测连通性；
  顺手探测接口支不支持 `response_format=json_object` 并记住结论。token 只存本机，不进导出包、不写日志。
- LLM 客户端：地址归一化（填 `.../chat/completions` 也认）、超时、错误分类
  （401 / 404 / 429 / 5xx / 非 JSON / 空内容 / 不支持图片）、并发上限 1、调用日志只记估算 token。
- `food.resolve`：库里没有的食物批量问模型（一次 ≤10 条），过一遍范围与宏量自洽校验，
  可疑项要用户确认才落库；失败自动进待办队列，**记录链路永不被模型阻塞**。
- 一句话 / 拍照记录（`/log/quick`）：任意描述（可带 ≤3 张压缩后的图片）→ 草稿 → 澄清追问 →
  确认落库；估不准就逐条问，答「记不清 / 不记」也允许，算不出的先记「待补全」并参与后续重算。
- 澄清引擎：问题按 `<条目>.<字段>` 去重、阻塞项（克数 / 时长 / 组次重量）优先、
  遵守「不再追问」名单；本地能折算的（如库里登记了「1个 = 50g」）直接填并写明假设。

## 已实现（阶段 3 · 报告）

- 报告摘要（`domain/reportDigest.ts`）：周期 / 覆盖率 / 均值 / 达标天数 / 体重变化 / 训练聚合 /
  当前目标 / TDEE，全部本地算，**不含任何原始记录**；它是喂给模型的全部输入。
- 周报月报（`llm/tasks/report.ts` + `domain/reportGuard.ts`）：模型只写文字，
  三道本地闸门把关 —— 数字守卫（正文数字必须在摘要里出现过）、校准幅度 ≤ ±150 kcal、
  覆盖率 < 50% 不给校准建议。
- 报告页（`/reports`、`/reports/:id`）：数值区（不可编辑）与文字区（可编辑并留痕）分区，
  待核对数字就地高亮；没配模型也能先生成数值区，重新生成不覆盖旧版本。

推荐周计划、校准向导、导入导出属于阶段 3.4–4，见设计文档 §13。

## 两条工程约定

1. **不写绝对路径**：与工作区一致，所有路径都是相对的。
2. **口径变更要两边同步**：确定性计算的公式与口径以工作区 `scripts/nutrition.py` 为准；
   改动 `src/domain/` 的计算逻辑时，必须同时更新 `docs/pwa-design.md` §5.2 并补充对拍测试。
