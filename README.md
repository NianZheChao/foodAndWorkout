# 减脂增肌工作区

以 Markdown 为唯一数据源、由 skill + 脚本驱动的个人减脂增肌记录与决策工作区。

## 工作方式

- 录入时只需要描述"吃了什么、怎么做、练了什么"。份量换算与营养统计由 agent / 脚本完成。
- 记录文件是唯一事实来源。所有推荐与复盘都从历史记录推导，不依赖记忆或猜测。
- 分工：`scripts/nutrition.py` 负责数表格里的数字（汇总、趋势、TDEE 反推、格式校验）；skill 负责判断与推荐。

## 目录

| 路径 | 内容 |
| --- | --- |
| `profile.md` | 基础档案：性别年龄身高体重、阶段目标、伤病、忌口、大致库存（食材与调味料）、可用器材 |
| `targets.md` | 短期可变的决策变量：热量与宏量目标、训练策略、TDEE 校准记录 |
| `records/YYYY-MM-DD.md` | 每日记录（摄入 + 训练），唯一的事实来源 |
| `plans/YYYY-Www.md` | 周计划（前瞻） |
| `reviews/YYYY-Www-review.md` | 周 / 月复盘（回溯） |
| `data/foods.csv` | 食材营养库，每 100g / 100ml 可食部 |
| `templates/` | 各类文件的模板；`example-day.md` 是一份填好的示例 |
| `scripts/nutrition.py` | 统计与校验工具 |
| `skills/` | 三套 skill 的源文件（本仓库为准），用 `install-skills.ps1` / `install-skills.sh` 安装到 Codex 技能目录 |

仓库内不写死任何绝对路径：脚本按自身位置定位工作区，所以克隆到哪个目录都能直接用。

## 每日工作流

1. `python scripts/nutrition.py new` —— 从模板创建当日文件（已存在则不覆盖）。
2. 记录体重 / 睡眠到 front-matter；每餐按"每个食材一行"写入摄入表；每个动作一行写入训练表。
3. `python scripts/nutrition.py check` —— 校验格式与数值。
4. `python scripts/nutrition.py totals --write` —— 汇总当日数据并写回文件。
5. 需要推荐时调用 `fatloss-plan`。

## 首次使用

1. 填 `profile.md`：顶部字段（性别、年龄、身高、体重、阶段目标、训练水平）+ 正文里的伤病忌口、大致库存、可用器材。
   库存只需写个大概，它是推荐食谱时的**优先使用范围而不是硬约束**——目标是让你尽量不用额外采购。
2. `python scripts/nutrition.py init --write` —— 用 Mifflin-St Jeor 公式估算 BMR / TDEE，按阶段（减脂 / 增肌 / 重组）生成热量与宏量目标并写入 `targets.md`。
3. 之后按"每日工作流"记录。`init` 只是启动值：每 2-4 周用 `tdee` 命令按实际体重变化重新校准，调整结果回写 `targets.md`。

## 多端使用

工作区就是一个普通 Git 仓库，数据全是纯文本，用 Git 同步到任意设备。

```bash
git clone https://github.com/NianZheChao/foodAndWorkout.git
cd foodAndWorkout
```

装 skill（每台设备装一次）：

```bash
powershell -ExecutionPolicy Bypass -File install-skills.ps1   # Windows
bash install-skills.sh                                        # macOS / Linux
```

- 日常改动的 commit / push 由 skill 在写完后自动完成，流程见下面「本地改动同步」。
- `skills/` 是 skill 的唯一源；改完 skill 要重跑安装脚本才生效。
- 冲突通常只出现在同一天两台设备都写了同一份记录文件时，按日期手工合并即可。
- 换设备后留意 `profile.md` 顶部字段与 `records/` 里的体重是否最新。

> 仓库若是公开的，体重、年龄、作息等个人信息会公开可见。介意的话把仓库改成私有，或把 `profile.md` 里的敏感数字挪到一个不提交的本地文件。

## 本地改动同步（自动 commit + push）

skill 每写完一批文件（记录 / 计划 / 复盘）就把改动同步到 GitHub；只 commit 不 push 的话，另一台设备拿到的是旧数据。

```bash
git add <本次改动的路径>
git commit -m "<log|plan|review>: <日期或周号> <摘要>"
git pull --rebase --autostash
git push
```

- **只加本次动过的文件**（如 `records/2026-10-10.md`、`data/foods.csv`、`profile.md`），不要 `git add -A`，免得把无关改动一起提交。
- commit message 形如 `log: 2026-10-10 摄入与训练`、`plan: 2026-W42 周计划`、`review: 2026-W41 复盘`。
- 开始新一轮记录前（尤其刚换设备）先 `git pull --rebase --autostash`。
- **暂存区为空就直接结束**，没有改动不需要空提交。

停止条件——满足任一条就停下，把情况报给用户，不要自行处置：

- `pull --rebase` 出现冲突。只有同一天在两台设备上写了同一份记录文件才会发生；保留双方内容后手工合并，或交给用户决定。
- `push` 被拒且不是 fast-forward：先 `pull --rebase` 再试一次，仍失败就停。
- 任何情况下都不要 `push --force`、不要 `git reset --hard`、不要删改 `records/` 里的历史文件。

多端同步靠「数据文件全部入库 + 本机产物全部忽略」：`.gitignore` 只排除缓存、编辑器目录和 `*.local.md` 这类本机内容；`records/`、`plans/`、`reviews/`、`data/`、`profile.md`、`targets.md` 一律参与同步，不要给它们加忽略规则。

## 记录文件格式契约

脚本与 skill 依赖下面的字段名和列名关键字。**列的顺序可以调整，列名关键字不要改。**

### front-matter

```yaml
date: 2026-10-10      # 必填，必须与文件名一致
weekday: 六
weight_am_kg: 72.4    # 晨起空腹（排尿后）体重，趋势与 TDEE 的唯一基准
weight_pm_kg: 73.1    # 睡前体重，只用于算夜间净流失；没称就留空
sleep_hours: 7.5
energy: 4             # 主观精力 1-5
soreness: 2           # 肌肉酸痛 1-5
water_ml: 2200
```

### 体重口径

- `weight_am_kg` 是晨重、`weight_pm_kg` 是睡前重，两个字段各自独立；没称就留空，不要用另一个补。
- **晨重是趋势与 TDEE 的唯一基准**：`trend` 的均线、`tdee` 的斜率都只看晨重。睡前体重只用来算「夜间净流失」，不参与均线。
- 早期记录里的 `weight_kg` 作为兼容字段保留：某天没有晨重时才用它兜底，`trend` 会给它标 `*`。
- **夜间净流失 = 当天晨重 − 前一天睡前重**。它反映的是水分与肠内容物，**不是"夜间代谢"**：一夜 600 kcal 的消耗，真正以质量离开身体的只有约 200 g（呼出的 CO₂），而水分日常波动 ±500 g，能量那一份被淹没在噪声里。
- 同日「睡前 − 晨重」= 当天摄入的食物与液体净质量，可以用来粗查是否漏记。

### 主观字段口径

`soreness` 与 `energy` 都是 1-5 自评，含义固定，不要按当天心情随口给：

| 值 | soreness（肌肉酸痛） | energy（主观精力） |
| ---: | --- | --- |
| 1 | 几乎无感 | 很差，只想躺着 |
| 2 | 轻微，按压或发力时才有感觉 | 偏低，能应付日常但不想训练 |
| 3 | 明显，活动时能感觉到，但不影响动作幅度与发力 | 一般，可以正常训练 |
| 4 | 较强，动作幅度或发力受一点影响 | 不错，训练状态在线 |
| 5 | 严重，日常动作受限 | 很好，明显有劲 |

- 酸痛只算**肌肉**。关节痛、单侧痛、肿热、麻木、尿色变深不是酸痛：按伤病处理并建议就医，不要塞进 1-5 里凑一个数。
- `sleep_hours` 填**实际睡着时长**，不是躺床时长；作息明显偏离平时的，把起止时间写进备注。

### 摄入表

列名：`餐次 | 菜品/做法 | 食材 | 份量 | 热量(kcal) | 蛋白(g) | 脂肪(g) | 碳水(g) | 纤维(g) | 钠(mg)`

- **一行 = 一个食材。** 同一道菜的多个食材共享同一个`菜品/做法`，便于看清这道菜由什么构成。
- `餐次`只能是`早餐`、`午餐`、`晚餐`、`加餐`之一。
- 数值取自 `data/foods.csv` 按实际克数换算；做法带来的用油、糖、酱料要单独成行，不要藏在主料里。

### 训练表

列名：`时间 | 类型 | 时长(min) | RPE | 目标肌群 | 动作 | 组x次x重量 | 估算消耗(kcal)`

- **一行 = 一个动作。**
- `目标肌群`多个肌群用 `/` 分隔（如 `胸/三头`）。
- `组x次x重量`形如 `4x8x60kg`，自重动作写 `3x12x自重`；不按此格式填写时脚本按 1 组统计。
- 脚本用这一列算**容量负荷**（组×次×重量，自重不计），它是力量训练的主指标；`trend` 会按动作列出区间容量，同名动作跨窗口对比就是渐进超负荷。
- `类型`建议取值：力量 / 有氧 / 球类 / 拉伸 / 其他。
- **有氧与力量分开评估**：有氧主要看热量，`估算消耗(kcal) = MET × 3.5 × 体重(kg) / 200 × 时长(min)`，所以时长必填，缺了就算不出；力量主要看肌群刺激（每周有效组数、容量负荷、RPE），热量不必精算。两者都不计回热量目标，只用于观察活动量。

### AUTO 区块

`<!-- AUTO:SUMMARY:BEGIN -->` 与 `<!-- AUTO:SUMMARY:END -->` 之间的内容由脚本生成，**不要手改**。

## 单位与口径

| 项目 | 单位 |
| --- | --- |
| 热量 | kcal |
| 蛋白 / 脂肪 / 碳水 / 纤维 | g |
| 钠 | mg |
| 饮水 | ml |
| 体重 | kg |

- `data/foods.csv` 的数值是**每 100g / 100ml 可食部**；名称里标注了生熟的以标注为准，未标注的按生重。
- 食用油按**入锅量**记（如煎鸡胸用 10g 油就记 10g），不按锅底残留估算。
- `targets.md` 的热量目标已包含日常活动与训练的消耗，**不要把训练消耗再加回目标**；训练消耗仅用于观察活动量。

## 脚本命令

```bash
python scripts/nutrition.py init [--write]             # 首次估算热量与宏量目标
python scripts/nutrition.py new [--date D] [--force]   # 创建当日记录，幂等
python scripts/nutrition.py totals [D] [--write]       # 当日汇总 + 对比目标
python scripts/nutrition.py trend [--days 14]          # 趋势、7 日均线、达标率、肌群组数与容量负荷、训练明细
python scripts/nutrition.py tdee [--days 28]           # 由摄入与体重变化反推 TDEE
python scripts/nutrition.py lookup 鸡胸 --g 200        # 查询食材营养
python scripts/nutrition.py check [D] [--all]          # 校验格式与数值
python scripts/nutrition.py week [D]                   # 查看周编号与计划文件状态
```

脚本只读解析、把结果打到 stdout；只有 `new` 和 `totals --write` 会写文件。无第三方依赖。

## 每周工作流

1. 周初：`fatloss-plan` 生成 `plans/YYYY-Www.md`。
2. 周末：`fatloss-review` 统计趋势与达标率，写 `reviews/`，必要时校准并发回 `targets.md`。

## skill 索引

| skill | 职责 |
| --- | --- |
| `fatloss-log` | 新建当日文件、记录每餐与每组训练、记录体重 |
| `fatloss-plan` | 基于历史与基础信息推荐训练与食谱，生成周计划 |
| `fatloss-review` | 周 / 月复盘，反推真实 TDEE，校准并回写目标 |

## 免责声明

本工作区提供的是基于公开营养学与训练学常识的记录工具与建议，**不构成医疗建议**。有基础疾病、进食障碍、孕期或伤痛的，请先咨询医生或注册营养师。体重变化建议控制在每周 0.5%~1% 体重以内，不要长期执行极端低热量饮食。
