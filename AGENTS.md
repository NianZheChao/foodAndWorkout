# 仓库约定（薄肌计划 PWA）

这个仓库只放应用本体与其验收基准。**任何个人数据都不许进仓库**（见下）。

## 命令

- 改动 `app/` 后至少跑 `npm test` 与 `npm run build`（都在 `app/` 下），两者都要过。
- 改了确定性计算的口径或记录文件解析：先 `npm run expected` 重生成对拍期望值，再 `npm test`，
  并同步更新 `docs/pwa-design.md` §5.2。
- 测 PWA 行为用 `npm run preview`（`npm run dev` 里 Service Worker 不参与）。

## 隐私与数据

- **仓库里不能出现真实记录、档案、目标或个人身份信息**。`app/tests/fixtures/` 下的记录与档案是
  合成数据；新增用例也要用合成数据，不要从真机或自己的记录里拷贝。
- 使用者数据只存在各自设备的 IndexedDB 里，没有后端、不做同步；跨设备迁移靠导出 / 导入（阶段 4）。
- 模型 token 只存本机：不进导出包、不写日志、不在错误提示里回显。

## 目录与移植

- **不写绝对路径**：代码、文档、测试里一律用相对路径。
- **文件 LF 行尾、无 BOM**：`.gitattributes` 要求 `*.md text eol=lf`。
- `scripts/nutrition.py` 按自身位置定位工作区，从任意工作目录执行都可以；命令优先在 `app/` 下用
  `npm run ...`。
- `data/foods.csv` 是种子食物库与脚本的共同数据源；`npm run seed` 由它生成
  `app/src/data/seed/foods.seed.ts`。

## 计算与模型边界

1. **确定性计算一律本地算，禁止交给模型**：换算、汇总、占比、均线、达标率、容量负荷、TDEE 反推
   全部在 `app/src/domain/`。模型只负责「把用户的话解析成结构」和「把本地摘要写成文字」。
2. **模型输出必须先解析、再 Zod 校验、后落库**；两次失败不写任何数据，并保留用户原文。
3. **记录链路永不被模型阻塞**：未配模型 / 断网时也要能记，占位 + 排队，汇总标「不完整」。
4. **报告的数值区永远本地算、永远不可编辑**：模型只写文字；被数字守卫标出的「待核对」数字只标记不改写。
5. **队列重放必须传 `{ enqueueOnFailure: false }`**，否则「重试失败 → 又排一条」会让队列自增。
6. **写库前把响应式对象拍平**：界面传进 `application/` 的对象可能是 Vue 响应式代理，直接 `put` 会
   `DataCloneError`，落库前深拷一份纯 JSON。
7. **新增模型任务要声明输入预算**：`LlmTask.inputBudget`（FR-1413 的目标值）与 `maxOutputTokens`
   一起构成预算告警的基线，估算超基线 2 倍时界面用 `confirmOverBudget`（`app/budget.ts`）问一句；
   这个确认通道是可选的，**队列与后台一律不传**（告警不拦记录链路）。

## 界面

- 新页面用 `app/src/components/AppHeader.vue` 开头（标题 + 副标题 + `back`）：底部 tab 只有五个入口，
  二级页面必须自带退路。
- 样式用 `app/src/style.css` 里的全局基元（`.card` / `.kv` / `.stat` / `.progress` / `.data-table` 等），
  页面 `<style scoped>` 只写这一页特有的东西；页面间距由 `.page` / `.panel` 的 flex gap 负责。

## 同步

改完按下面顺序同步到 GitHub：只 `git add` 本次动过的文件，`git pull --rebase --autostash` 之后再
`git push`。遇到冲突或推送被拒就停下报告，不要 `push --force`（历史清理这类操作必须由用户显式授权），
也不要回退历史。
