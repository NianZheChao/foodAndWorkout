---
name: fatloss-review
description: 在减脂增肌工作区（foodAndWorkout：含 README.md 格式契约与 scripts/nutrition.py 的目录树）做复盘与校准——统计一段时间的趋势与达标率、由实际体重变化反推真实 TDEE、生成周/月复盘并把调整写回 targets.md。当用户要求复盘、看进展、抱怨体重停滞、或问要不要调整热量与训练量时使用。
---

# 复盘与校准（fatloss-review）

**定位工作区**：工作区是包含 `README.md`（格式契约）、`scripts/nutrition.py` 与 `records/` 的目录树，默认就是当前工作目录。不确定时先找 `scripts/nutrition.py`；找不到就问用户要路径。**不要把任何绝对路径写进文件或命令。**

**命令由你执行，用户不会手敲。** 在工作区根目录用相对路径运行 `python scripts/nutrition.py ...`。若当前目录不是工作区根目录，用 `python <工作区路径>/scripts/nutrition.py ...`——脚本按自身位置定位工作区，从任何 cwd 都能正常运行。

## 取数据

```bash
python scripts/nutrition.py init                # 仅当 targets.md 还没有任何目标值时
python scripts/nutrition.py check --all         # 先过关，否则结论不可信
python scripts/nutrition.py trend --days 7      # 或 14 / 28
python scripts/nutrition.py tdee --days 28
```

`check --all` 报错时先修数据再分析——被污染的输入会让趋势和 TDEE 一起失真。
`targets.md` 的目标值为空时（还没有任何校准）先用 `init --write` 生成启动值，再进入复盘。

## 判断规则

- **看趋势不看单日**：用 7 日均线与"周均变化率"下结论。单日 ±1kg 的波动是水分，不是脂肪。
- **速率区间**：减脂 -0.5%~-1% 体重/周；增肌 +0.25%~+0.5% 体重/周。明显偏离才值得调整。
- **小步调整**：需要调整时每次只动 ±100~150 kcal，然后观察 1-2 周再评估。不要一次砍 500 kcal。
- **身体成分优于体重**：体重没动但力量上升、围度下降，说明在重组，别急着加大缺口。
- **体脂偏高时蛋白目标按瘦体重算**：体重偏高（例如 BMI ≥ 28）时，`体重 x 2.0` 会高估需要。改用目标体重 x 2.0~2.2 或当前体重 x 1.6 重新核算，并同步改 `protein_target_g`。
- **校准频率**：每 2-4 周，或体重停滞 ≥10 天时，用 `tdee` 重算，而不是每周都改。
- **训练侧同样要复盘**：各肌群周组数是否达到下限、容量负荷是否在推进（`trend` 的训练明细按动作给出区间容量，同名动作跨窗口对比）、是否连续 6 周以上没有减载。
- **体重口径**：趋势与 TDEE 只用晨重。`trend` 里带 `*` 的是旧字段 `weight_kg` 兜底（口径不明），只有睡前体重的日期不进均线——下结论时要说明样本里有多少天是这种。
- `tdee` 的估计受水分、漏记、体脂秤误差影响。样本少于 14 天要标注为"初步估算"，报数时说明置信度。

## 输出

1. 按 `templates/weekly-review.md` 写入 `reviews/YYYY-Www-review.md`：数据表、执行情况、有效做法、问题、下周调整。
2. 需要改目标时，改 `targets.md` 的 front-matter，**并同时**在"校准记录"表补一行（日期 / 实测 TDEE / 调整前后 / 依据）。
3. 明确区分事实（记录里的数字）与推断（你的解释），把推断标出来。

## 同步

写完 `reviews/` 与 `targets.md` 之后，按 `README.md` 的「本地改动同步」commit 并 push（`review: <周号> 复盘`）。冲突或推送被拒就停下报告，不要 `push --force`。

## 边界

- 不做医疗判断。出现持续疲劳、睡眠障碍、月经异常、关节疼痛等情况，建议就医或咨询注册营养师，而不是继续加训练量。
- 不为了"让曲线好看"而修改记录口径或删除不符合预期的数据。
