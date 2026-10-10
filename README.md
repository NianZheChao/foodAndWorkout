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

- 日常就是 `git pull` / `git commit` / `git push`。
- `skills/` 是 skill 的唯一源；改完 skill 要重跑安装脚本才生效。
- 冲突通常只出现在同一天两台设备都写了同一份记录文件时，按日期手工合并即可。
- 换设备后留意 `profile.md` 顶部字段与 `records/` 里的体重是否最新。

> 仓库若是公开的，体重、年龄、作息等个人信息会公开可见。介意的话把仓库改成私有，或把 `profile.md` 里的敏感数字挪到一个不提交的本地文件。

## 记录文件格式契约

脚本与 skill 依赖下面的字段名和列名关键字。**列的顺序可以调整，列名关键字不要改。**

### front-matter

```yaml
date: 2026-10-10      # 必填，必须与文件名一致
weekday: 六
weight_kg: 72.4       # 留空表示当天没有称重，不要为了填满而臆造
sleep_hours: 7.5
energy: 4             # 主观精力 1-5
soreness: 2           # 肌肉酸痛 1-5
water_ml: 2200
```

### 摄入表

列名：`餐次 | 菜品/做法 | 食材 | 份量 | 热量(kcal) | 蛋白(g) | 脂肪(g) | 碳水(g) | 纤维(g) | 钠(mg)`

- **一行 = 一个食材。** 同一道菜的多个食材共享同一个`菜品/做法`，便于看清这道菜由什么构成。
- `餐次`只能是`早餐`、`午餐`、`晚餐`、`加餐`之一。
- 数值取自 `data/foods.csv` 按实际克数换算；做法带来的用油、糖、酱料要单独成行，不要藏在主料里。

### 训练表

列名：`时间 | 类型 | 时长(min) | RPE | 目标肌群 | 动作 | 组x次x重量 | 估算消耗(kcal)`

- **一行 = 一个动作。**
- `目标肌群`多个肌群用 `/` 分隔（如 `胸/三头`）。
- `组x次x重量`形如 `4x8x60kg`；不按此格式填写时脚本按 1 组统计。
- `类型`建议取值：力量 / 有氧 / 球类 / 拉伸 / 其他。

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
python scripts/nutrition.py trend [--days 14]          # 趋势、7 日均线、达标率、肌群组数
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
