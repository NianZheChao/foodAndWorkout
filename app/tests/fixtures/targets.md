---
# 机器可读字段：scripts/nutrition.py 读取这些目标值做达标对比。由 fatloss-review 校准后回写。
tdee_kcal: 2846
kcal_target: 2420
protein_target_g: 176
fat_target_g: 70
carb_target_g: 270
fiber_target_g: 30
sodium_max_mg: 2300
water_target_ml: 2500
weekly_training_days: 3
weekly_sets_per_muscle: 10
target_weight_kg: 65
target_rate_kg_per_week: -0.39
review_cadence: weekly
last_calibrated: 2026-10-10
---

# 目标与策略

短期可变的决策变量。由 `fatloss-review` 依据实际体重与摄入数据校准后回写；`fatloss-plan` 读取它来出方案。

## 当前阶段

- 阶段：减脂
- 起始日期：2026-10-10
- 目标体重：65 kg（起点 88 kg，需减 23 kg）
- 目标速率（kg/周）：-0.39（约 -0.44% 体重/周）
- 预计达成日期：约 2027-11（按当前速率线性外推；实际会随体重下降而变慢，需定期校准）

## 热量与宏量目标

每日热量目标 = TDEE + 阶段调整（减脂 -10% ~ -20%，增肌 +5% ~ +15%）。

| 项目 | 目标 | 依据 |
| --- | ---: | --- |
| TDEE(kcal) | 2846 | Mifflin-St Jeor：BMR 1836（88kg / 173cm / 26岁 / 男）x 活动系数 1.55 |
| 热量(kcal) | 2420 | TDEE -15% |
| 蛋白质(g) | 176 | 2.0 g/kg 体重 |
| 脂肪(g) | 70 | 0.8 g/kg 体重 |
| 碳水(g) | 270 | 剩余热量 |
| 纤维(g) | 30 | |
| 钠上限(mg) | 2300 | |
| 饮水(ml) | 2500 | |

## 训练策略

- 每周训练天数：3（由"新手"推定；实际天数不同会影响 TDEE，请更正后重跑 init）
- 分化方式：待定（有哑铃 / 杠铃 / 跑步机 / 划船机，建议先全身训练，由 fatloss-plan 定）
- 每次时长：待定
- 每肌群每周有效组数下限：10（新手起点）
- 渐进超负荷规则：同一重量完成计划组数上限后，下次加重 2.5kg
- 计划中的减载（deload）安排：每 6-8 周，或连续两周力量下降时减载一周

## 校准记录

| 日期 | 实测 TDEE | 调整前后热量目标 | 依据 |
| --- | ---: | --- | --- |
| 2026-10-10 | 2846（估算，非实测） | → 2420 kcal | Mifflin-St Jeor：BMR 1836 x 活动系数 1.55，减脂取 -15% |
