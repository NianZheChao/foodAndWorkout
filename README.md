# 薄肌计划（PWA）

个人减脂增肌应用：记录饮食 / 训练 / 体重，本地算汇总与趋势；需要时让模型把一句话解析成结构化数据、
把本地摘要写成结论。

**没有后端**：记录、食物库、报告与配置全部存放在浏览器的 IndexedDB 里；除了使用者自己配置的
OpenAI 兼容模型接口，不向任何第三方发送数据（图片录入除外 —— 图片会发送给所配置的模型服务，且不落库）。

## 仓库里有什么

```
app/                 应用本体（Vue 3 + TypeScript + Vite + Vant + Dexie）
docs/                需求 / 设计 / 开发进度
scripts/nutrition.py 计算口径的验收基准（对拍用）
data/foods.csv       食物营养表：种子食物库的来源，也是脚本的数据源
```

**这个仓库不存放任何个人数据。** 记录、档案、目标由使用者在自己的设备上录入，只存在那台设备的
浏览器里；`app/tests/fixtures/` 下的记录与档案是**合成数据**，仅用于测试（见 `AGENTS.md`）。

## 快速开始

```bash
cd app
npm install
npm test          # 单元 / 对拍 / 组件测试
npm run build     # 类型检查 + 生产构建（产物在 app/dist/）
npm run preview   # 预览构建产物；测 PWA 行为必须用它，dev 模式下 Service Worker 不参与
```

其它脚本：`npm run seed`（从 `../data/foods.csv` 重新生成内置食物库）、
`npm run expected`（重新生成对拍期望值）、`npm run icons`（重新生成 PWA 图标）。

## 部署与分发

线上地址：**https://nianzhechao.github.io/foodAndWorkout_deploy/**（`main` 的产物即最新版）。

产品给使用者的是**一个网址**：iPhone 用 Safari 打开 → 「分享 → 添加到主屏」，装完就是独立窗口、
离线可用（Service Worker 预缓存全部静态资源）。数据只存在使用者自己的浏览器里，服务器不留任何东西。

### 怎么发

```bash
cd app
npm run deploy          # 类型检查 + 构建（base=/foodAndWorkout_deploy/）+ 推到部署仓库
npm run deploy -- --dry-run   # 只构建与准备，看清会动哪些文件
```

- 部署落在**独立仓库** `NianZheChao/foodAndWorkout_deploy`（只装产物，不进本体仓库的历史）；
  脚本是 `app/scripts/deploy-pages.mjs`，一次发布一个提交，要回滚就回滚到上一个提交。
- 产物里额外放两个托管侧要的文件：`.nojekyll`（别让 Jekyll 吃掉下划线开头的文件）与
  `404.html`（SPA 回退，见下）。
- GitHub Pages 设置（**一次性**，只在新仓库第一次发布前做）：Settings → Pages →
  Source = `Deploy from a branch`，分支 `main`，目录 `/ (root)`。

### 换托管（或自有域名）要动的地方

构建产物是纯静态文件，但有三条硬要求：

1. **HTTPS**：Service Worker 与「添加到主屏」都要求安全上下文；局域网 `http://192.168.x.x` 装不上。
2. **路径前缀与 base 一致**：Vite 的资源地址由 `base` 决定（`npm run deploy -- --base=/`、或
   `npm run build -- --base=/xxx/`）。manifest 与 Service Worker 里的地址全是相对路径，
   scope / start_url / precache 会跟着站点路径自动对上，**不需要再改 `vite.config.ts`**。
3. **SPA 回退**：从主屏冷启动会直接请求 `/today`，服务器要把未知路径回退到 `index.html`。
   GitHub Pages 靠上传的 `404.html`（部署脚本自动生成）；Netlify / Cloudflare Pages 在
   `_redirects` 里写一行 `/* /index.html 200`。

任何静态托管都可以放 `app/dist/`（Netlify Drop、Cloudflare Pages 直接上传最省事），
iPhone 上必须用 **Safari** 打开再「添加到主屏」。

## 质量手段：与脚本对拍

`scripts/nutrition.py` 是计算口径的验收基准。`npm run expected` 会把它组装进一个**临时工作区**
（脚本 + `data/foods.csv` + `app/tests/fixtures/` 里的合成记录与档案），跑
`totals` / `trend` / `tdee` / `init`，输出写到 `app/tests/fixtures/expected-*.txt`；
`npm test` 再把同一批 fixture 喂给 `io/markdown` + `domain/`，与期望值逐项比对。

所以：**改了 `app/src/domain/` 的口径、或改了记录文件的解析，就要重跑 `npm run expected`**，
并同步更新 `docs/pwa-design.md` §5.2。期望值变了说明口径真的变了 —— 先确认那是想要的改动。

## 文档

- `docs/pwa-requirements.md`：产品范围、领域口径、功能需求编号
- `docs/pwa-design.md`：架构、数据层、LLM 契约、界面设计、实施计划（§13）
- `docs/pwa-progress.md`：现在做到哪一步、还差什么、踩过哪些坑（接手先读这份）
