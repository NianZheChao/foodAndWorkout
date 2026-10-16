<script setup lang="ts">
/**
 * 趋势（M6 / FR-600）。全部本地计算，不依赖模型与网络（FR-609）。
 *
 * 页面只负责展示：数值全部来自 `domain/trend.ts` 的区间聚合，
 * 与 `scripts/nutrition.py trend` 同口径（tests/trend.spec.ts 逐项对拍）。
 * 空值一律显示 `-`，与真实的 0 区分（DR-04）。
 */

import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import EchartView, { type ChartOption } from '@/components/EchartView.vue'
import { chartPalette } from '@/app/chartTheme'
import { useResolvedTheme } from '@/app/theme'
import { addDays, formatDateCn, recentDates, todayIso } from '@/app/date'
import { getTargets } from '@/data/repositories/targets'
import { listDaysInRange } from '@/data/repositories/days'
import { listIntakeInRange } from '@/data/repositories/intake'
import { listWorkoutInRange } from '@/data/repositories/workout'
import { sumFacts } from '@/domain/nutrition'
import { fmtNumber, fmtPercent, fmtSigned } from '@/domain/format'
import { roundToTdeeStep } from '@/domain/tdee'
import {
  buildTrend,
  MA_WINDOW,
  normalizeTrendWindow,
  TREND_WINDOWS,
  type TrendDayInput,
  type TrendResult,
  type TrendWindow
} from '@/domain/trend'
import type { TargetsRecord } from '@/domain/types'

/**
 * 图表配色跟着外观走（FR-1606）：ECharts 把颜色直接画进 SVG，**读不到 CSS 变量**，
 * 所以按外观给两套取值（`app/chartTheme.ts`）。那里与 `style.css` 的 token 逐项对齐，
 * 由 `tests/theme-tokens.spec.ts` 比对 —— 改一处忘另一处会直接失败。
 */
const theme = useResolvedTheme()
const palette = computed(() => chartPalette(theme.value))

/*
 * 轴 / 图例 / 提示框的公共样式：ECharts 的默认配色是照着浅色底定的 —— 轴标签与图例是深灰、
 * 提示框写死白底。深色下前者糊在近黑的背景里、后者点一下闪一块白，所以一律跟着 token 走。
 */
const axisLabel = computed(() => ({ fontSize: 10, color: palette.value.text }))
const axisName = computed(() => ({ fontSize: 10, color: palette.value.text }))
const splitLine = computed(() => ({ lineStyle: { color: palette.value.splitLine } }))
const tooltip = computed(() => ({
  trigger: 'axis' as const,
  backgroundColor: palette.value.tooltipBg,
  borderColor: palette.value.tooltipBorder,
  textStyle: { color: palette.value.text }
}))
/** 图表内边距：ECharts 6 的 `containLabel` 需要额外特性包，这里直接用固定留白。 */
const GRID = { left: 48, right: 52, top: 36, bottom: 24 }

const route = useRoute()
const router = useRouter()

const windowDays = computed(() => normalizeTrendWindow(route.query.days))
const loading = ref(false)
const trend = shallowRef<TrendResult>()
const targets = shallowRef<TargetsRecord>()

const hasTargets = computed(() => !!targets.value)

/** 没有目标值时留空，图表不画目标线、对比列显示 `-`。 */
const targetValues = computed(() => ({
  kcalTarget: targets.value?.kcalTarget ?? 0,
  proteinTargetG: targets.value?.proteinTargetG ?? 0,
  fatTargetG: targets.value?.fatTargetG ?? 0,
  carbTargetG: targets.value?.carbTargetG ?? 0,
  fiberTargetG: targets.value?.fiberTargetG ?? 0,
  sodiumMaxMg: targets.value?.sodiumMaxMg ?? 0,
  weeklySetsPerMuscle: targets.value?.weeklySetsPerMuscle
}))

const shortDate = (date: string): string => date.slice(5)
const round1 = (value: number): number => Number(value.toFixed(1))

async function load(): Promise<void> {
  loading.value = true
  try {
    const end = todayIso()
    const start = addDays(end, -(windowDays.value - 1))
    const before = addDays(start, -1)
    const [dayRows, beforeRow, targetsRow, intakeRows, workoutRows] = await Promise.all([
      listDaysInRange(start, end),
      listDaysInRange(before, before),
      getTargets(),
      listIntakeInRange(start, end),
      listWorkoutInRange(start, end)
    ])
    targets.value = targetsRow

    const dayByDate = new Map(dayRows.map((row) => [row.date, row]))
    const intakeByDate = new Map<string, typeof intakeRows>()
    for (const row of intakeRows) {
      const bucket = intakeByDate.get(row.date)
      if (bucket) bucket.push(row)
      else intakeByDate.set(row.date, [row])
    }
    const workoutByDate = new Map<string, typeof workoutRows>()
    for (const row of workoutRows) {
      const bucket = workoutByDate.get(row.date)
      if (bucket) bucket.push(row)
      else workoutByDate.set(row.date, [row])
    }

    const days: TrendDayInput[] = recentDates(end, windowDays.value).map((date) => {
      const dayRow = dayByDate.get(date)
      const entries = intakeByDate.get(date) ?? []
      return {
        date,
        weightAmKg: dayRow?.weightAmKg,
        weightPmKg: dayRow?.weightPmKg,
        intake: sumFacts(entries.map((entry) => entry.computed)),
        hasIntakeRows: entries.length > 0,
        workouts: workoutByDate.get(date) ?? []
      }
    })

    const previousRow = beforeRow[0]
    trend.value = buildTrend({
      days,
      targets: targetValues.value,
      windowDays: windowDays.value,
      previousDay: previousRow
        ? {
            date: previousRow.date,
            weightPmKg: previousRow.weightPmKg,
            intake: sumFacts([]),
            hasIntakeRows: false,
            workouts: []
          }
        : undefined
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(windowDays, load)

function switchWindow(days: TrendWindow): void {
  if (days === windowDays.value) return
  void router.replace({ query: { ...route.query, days: String(days) } })
}

const rows = computed(() => trend.value?.rows ?? [])

const weightOption = computed<ChartOption>(() => ({
  tooltip: tooltip.value,
  legend: { data: ['晨重', '7 日均线'], top: 0, itemHeight: 8, textStyle: { fontSize: 11, color: palette.value.text } },
  grid: GRID,
  xAxis: {
    type: 'category',
    data: rows.value.map((row) => shortDate(row.date)),
    axisLabel: axisLabel.value
  },
  yAxis: {
    type: 'value',
    scale: true,
    name: 'kg',
    nameTextStyle: axisName.value,
    axisLabel: axisLabel.value,
    splitLine: splitLine.value
  },
  series: [
    {
      name: '晨重',
      type: 'scatter',
      symbolSize: 7,
      itemStyle: { color: palette.value.series1 },
      data: rows.value.map((row) => (row.weightAmKg === undefined ? null : round1(row.weightAmKg)))
    },
    {
      name: '7 日均线',
      type: 'line',
      smooth: true,
      symbolSize: 4,
      itemStyle: { color: palette.value.series2 },
      connectNulls: false,
      data: rows.value.map((row) => (row.ma === undefined ? null : Number(row.ma.toFixed(2))))
    }
  ]
}))

const intakeOption = computed<ChartOption>(() => {
  const kcalTarget = targetValues.value.kcalTarget
  const proteinTarget = targetValues.value.proteinTargetG
  return {
    tooltip: tooltip.value,
    legend: { data: ['热量', '蛋白'], top: 0, itemHeight: 8, textStyle: { fontSize: 11, color: palette.value.text } },
    grid: GRID,
    xAxis: {
      type: 'category',
      data: rows.value.map((row) => shortDate(row.date)),
      axisLabel: axisLabel.value
    },
    yAxis: [
      { type: 'value', name: 'kcal', nameTextStyle: axisName.value, axisLabel: axisLabel.value, splitLine: splitLine.value },
      { type: 'value', name: 'g', nameTextStyle: axisName.value, axisLabel: axisLabel.value, splitLine: splitLine.value }
    ],
    series: [
      {
        name: '热量',
        type: 'bar',
        itemStyle: { color: palette.value.series1 },
        data: rows.value.map((row) => (row.hasIntakeRows ? round1(row.intake.kcal) : null)),
        markLine: kcalTarget
          ? {
              silent: true,
              symbol: 'none',
              label: { formatter: `热量目标 ${kcalTarget}`, fontSize: 10, position: 'insideEndTop', color: palette.value.text },
              lineStyle: { color: palette.value.series2, type: 'dashed' },
              data: [{ yAxis: kcalTarget }]
            }
          : undefined
      },
      {
        name: '蛋白',
        type: 'line',
        yAxisIndex: 1,
        symbolSize: 5,
        itemStyle: { color: palette.value.series3 },
        data: rows.value.map((row) => (row.hasIntakeRows ? round1(row.intake.proteinG) : null)),
        markLine: proteinTarget
          ? {
              silent: true,
              symbol: 'none',
              label: { formatter: `蛋白目标 ${proteinTarget}`, fontSize: 10, position: 'insideEndTop', color: palette.value.text },
              lineStyle: { color: palette.value.series3, type: 'dashed' },
              data: [{ yAxis: proteinTarget }]
            }
          : undefined
      }
    ]
  }
})

const trainingOption = computed<ChartOption>(() => ({
  tooltip: tooltip.value,
  legend: { data: ['容量负荷', '组数'], top: 0, itemHeight: 8, textStyle: { fontSize: 11, color: palette.value.text } },
  grid: GRID,
  xAxis: {
    type: 'category',
    data: rows.value.map((row) => shortDate(row.date)),
    axisLabel: axisLabel.value
  },
  yAxis: [
    { type: 'value', name: 'kg', nameTextStyle: axisName.value, axisLabel: axisLabel.value, splitLine: splitLine.value },
    { type: 'value', name: '组', nameTextStyle: axisName.value, axisLabel: axisLabel.value, splitLine: splitLine.value }
  ],
  series: [
    {
      name: '容量负荷',
      type: 'bar',
      itemStyle: { color: palette.value.series1 },
      data: rows.value.map((row) => (row.load ? round1(row.load) : null))
    },
    {
      name: '组数',
      type: 'line',
      yAxisIndex: 1,
      symbolSize: 5,
      itemStyle: { color: palette.value.series2 },
      data: rows.value.map((row) => (row.sets ? row.sets : null))
    }
  ]
}))
const tdeeRow = computed(() => {
  const estimate = trend.value?.tdee.estimate
  if (!estimate) return undefined
  return {
    ...estimate,
    step: roundToTdeeStep(estimate.tdeeKcal),
    confidence: trend.value?.tdee.confidence ?? ''
  }
})
</script>

<template>
  <section class="page">
    <AppHeader title="趋势" subtitle="全部本地计算，离线可用；睡前重不进均线与 TDEE。" />

    <div class="window-switch">
      <van-button
        v-for="days in TREND_WINDOWS"
        :key="days"
        size="small"
        :type="days === windowDays ? 'primary' : 'default'"
        :plain="days !== windowDays"
        @click="switchWindow(days)"
      >
        {{ days }} 天
      </van-button>
    </div>

    <div v-if="loading && !trend" class="card">
      <p class="muted">读取中…</p>
    </div>

    <template v-if="trend">
      <div class="card">
        <h2 class="card-title">区间与覆盖率</h2>
        <p class="muted">
          {{ trend.start ? `${formatDateCn(trend.start)} ~ ${formatDateCn(trend.end as string)}` : '-' }}
          · 共 {{ trend.days }} 天
        </p>
        <div class="kv">
          <span class="kv-key">有饮食记录</span>
          <span class="kv-value">
            {{ trend.coverage.daysWithIntake }} 天（{{ fmtPercent(trend.coverage.intakeRatio) }}）
          </span>
        </div>
        <div class="progress">
          <div class="progress-fill" :style="{ width: `${Math.round(trend.coverage.intakeRatio * 100)}%` }" />
        </div>
        <div class="kv">
          <span class="kv-key">有体重记录</span>
          <span class="kv-value">
            {{ trend.coverage.daysWithWeight }} 天（{{ fmtPercent(trend.coverage.weightRatio) }}）
          </span>
        </div>
        <div class="progress">
          <div class="progress-fill" :style="{ width: `${Math.round(trend.coverage.weightRatio * 100)}%` }" />
        </div>
        <div class="kv">
          <span class="kv-key">有训练记录</span>
          <span class="kv-value">{{ trend.coverage.daysWithTraining }} 天</span>
        </div>
        <ul v-if="trend.notes.length" class="hint-list">
          <li v-for="note in trend.notes" :key="note">{{ note }}</li>
        </ul>
      </div>

      <div v-if="trend.empty" class="card">
        <h2 class="card-title">区间内没有任何记录</h2>
        <p class="muted">
          这里区分「未记录」与「0」：没有记录就是空的，不会被当成 0 拉低平均值。
          先记一天，趋势就会出来。
        </p>
        <van-button type="primary" block @click="router.push('/log/diet')">去记饮食</van-button>
      </div>

      <template v-else>
        <div class="card">
          <h2 class="card-title">体重（晨重散点 + {{ MA_WINDOW }} 日均线）</h2>
          <EchartView :option="weightOption" label="体重趋势图" />
          <template v-if="trend.weight">
            <div class="kv">
              <span class="kv-key">区间变化</span>
              <span class="kv-value">
                {{ fmtNumber(trend.weight.first) }} → {{ fmtNumber(trend.weight.last) }} kg
                （{{ fmtSigned(trend.weight.changeKg) }} kg）
              </span>
            </div>
            <div class="kv">
              <span class="kv-key">周均变化</span>
              <span class="kv-value">
                {{ fmtSigned(trend.weight.perWeekKg) }} kg/周 · {{ fmtSigned(trend.weight.pctPerWeek) }}% 体重/周
              </span>
            </div>
            <div class="kv">
              <span class="kv-key">最新 7 日均线</span>
              <span class="kv-value">
                {{ trend.weight.latestMa === undefined ? '-' : `${fmtNumber(trend.weight.latestMa)} kg` }}
              </span>
            </div>
          </template>
          <p v-else class="muted">体重数据不足（至少需要 2 天有体重记录）。</p>
        </div>

        <div class="card">
          <h2 class="card-title">摄入 vs 目标</h2>
          <EchartView :option="intakeOption" label="摄入趋势图" />
          <div class="kv">
            <span class="kv-key">日均（{{ trend.intake.days }} 天有记录）</span>
            <span class="kv-value">
              {{ fmtNumber(trend.intake.avg.kcal) }} kcal · {{ fmtNumber(trend.intake.avg.proteinG) }} g 蛋白
            </span>
          </div>
          <div v-for="row in trend.intake.rows" :key="row.key" class="kv">
            <span class="kv-key">{{ row.label }} · 日均</span>
            <span class="kv-value">
              {{ fmtNumber(row.intake) }}
              <template v-if="row.target">
                / {{ row.key === 'sodiumMg' ? '≤' : '' }}{{ fmtNumber(row.target) }}
                （{{ fmtPercent(row.ratio) }}）
              </template>
              <template v-else>/ -</template>
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">热量达标（±10%）</span>
            <span class="kv-value">
              {{ trend.intake.kcalHit.hit }}/{{ trend.intake.kcalHit.total }} 天
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">蛋白达标（≥ 目标 90%）</span>
            <span class="kv-value">
              {{ trend.intake.proteinHit.hit }}/{{ trend.intake.proteinHit.total }} 天
            </span>
          </div>
          <p v-if="!hasTargets" class="muted">
            还没有目标值，达标率与目标线都算不出来。去「目标」页做一次首次校准。
          </p>
        </div>

        <div class="card">
          <h2 class="card-title">训练</h2>
          <div class="kv">
            <span class="kv-key">训练天数</span>
            <span class="kv-value">
              {{ trend.training.days }} 天
              <template v-if="trend.training.perWeekDays !== undefined">
                · 周均 {{ fmtNumber(trend.training.perWeekDays) }} 次
              </template>
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">总时长</span>
            <span class="kv-value">{{ fmtNumber(trend.training.minutes) }} 分钟</span>
          </div>
          <div class="kv">
            <span class="kv-key">总组数</span>
            <span class="kv-value">{{ trend.training.sets }}</span>
          </div>
          <div class="kv">
            <span class="kv-key">容量负荷</span>
            <span class="kv-value">{{ fmtNumber(trend.training.load) }} kg</span>
          </div>
          <p v-if="!trend.training.weeklyExtrapolated" class="muted">区间不足 7 天，不外推周均。</p>
          <template v-if="trend.training.days === 0">
            <p class="muted">区间内无训练记录。</p>
          </template>
          <template v-else>
            <EchartView :option="trainingOption" label="训练容量趋势图" />
            <table class="data-table">
              <thead>
                <tr>
                  <th>肌群</th>
                  <th>组数</th>
                  <th>容量(kg)</th>
                  <th>周均组数</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in trend.training.muscles" :key="row.name">
                  <td>{{ row.name }}</td>
                  <td class="num">{{ row.sets }}</td>
                  <td class="num">{{ fmtNumber(row.load) }}</td>
                  <td class="num">
                    {{ row.perWeekSets === undefined ? '-' : fmtNumber(row.perWeekSets) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <table class="data-table">
              <thead>
                <tr>
                  <th>动作</th>
                  <th>肌群</th>
                  <th>出现</th>
                  <th>组数</th>
                  <th>最近一次</th>
                  <th>区间容量</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="[name, move] in trend.moves" :key="name">
                  <td>{{ name }}</td>
                  <td>{{ move.muscles }}</td>
                  <td class="num">{{ move.dates.length }} 次</td>
                  <td class="num">{{ move.sets }}</td>
                  <td>{{ move.volume || '-' }}</td>
                  <td class="num">{{ fmtNumber(move.load) }}</td>
                </tr>
              </tbody>
            </table>
            <p class="muted">
              区间容量按窗口内同名动作求和；换个窗口（7 / 14 / 28 天）对比同一动作，就是渐进超负荷的量化视角。自重动作不计容量。
            </p>
          </template>
        </div>

        <div class="card">
          <h2 class="card-title">实测 TDEE（反推）</h2>
          <template v-if="tdeeRow">
            <div class="kv">
              <span class="kv-key">实测 TDEE</span>
              <span class="kv-value">
                {{ fmtNumber(tdeeRow.tdeeKcal) }} kcal · {{ tdeeRow.confidence }}
              </span>
            </div>
            <div class="kv">
              <span class="kv-key">建议取值（50 的整数倍）</span>
              <span class="kv-value">{{ fmtNumber(tdeeRow.step) }} kcal</span>
            </div>
            <div class="kv">
              <span class="kv-key">样本</span>
              <span class="kv-value">{{ tdeeRow.sampleDays }} 天（跨度 {{ tdeeRow.spanDays }} 天）</span>
            </div>
            <div class="kv">
              <span class="kv-key">平均摄入 / 每日能量差</span>
              <span class="kv-value">
                {{ fmtNumber(tdeeRow.meanIntake) }} kcal / {{ fmtSigned(tdeeRow.balanceKcal) }} kcal
              </span>
            </div>
            <div class="kv">
              <span class="kv-key">体重斜率（稳健 / 最小二乘）</span>
              <span class="kv-value">
                {{ tdeeRow.slope.toFixed(3) }} / {{ tdeeRow.leastSquaresSlope.toFixed(3) }} kg/天
              </span>
            </div>
          </template>
          <ul v-if="trend.tdee.warnings.length" class="hint-list">
            <li v-for="warning in trend.tdee.warnings" :key="warning">{{ warning }}</li>
          </ul>
          <p v-else-if="!tdeeRow" class="muted">有效数据不足，暂时反推不出 TDEE。</p>
          <p class="muted">
            水分与糖原波动、漏记、体脂秤误差都会污染这个估算，它只用来指方向。
            要改热量目标请走「目标」页的校准流程（会写一行校准记录）。
          </p>
          <van-button plain type="primary" block @click="router.push('/targets')">去目标页校准</van-button>
        </div>

        <div class="card">
          <h2 class="card-title">逐日数据</h2>
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>晨重</th>
                  <th>睡前</th>
                  <th>净流失</th>
                  <th>均线</th>
                  <th>热量</th>
                  <th>蛋白</th>
                  <th>脂肪</th>
                  <th>碳水</th>
                  <th>训练</th>
                  <th>组数</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in trend.rows" :key="row.date">
                  <td>{{ row.date.slice(5) }}</td>
                  <td class="num">
                    {{ fmtNumber(row.weightAmKg) }}<span v-if="row.legacy" class="legacy-mark">*</span>
                  </td>
                  <td class="num">{{ fmtNumber(row.weightPmKg) }}</td>
                  <td class="num">{{ fmtSigned(row.overnightKg) }}</td>
                  <td class="num">{{ fmtNumber(row.ma) }}</td>
                  <td class="num">{{ row.hasIntakeRows ? fmtNumber(row.intake.kcal) : '-' }}</td>
                  <td class="num">{{ row.hasIntakeRows ? fmtNumber(row.intake.proteinG) : '-' }}</td>
                  <td class="num">{{ row.hasIntakeRows ? fmtNumber(row.intake.fatG) : '-' }}</td>
                  <td class="num">{{ row.hasIntakeRows ? fmtNumber(row.intake.carbG) : '-' }}</td>
                  <td class="num">{{ row.hasTraining ? fmtNumber(row.minutes) : '-' }}</td>
                  <td class="num">{{ row.hasTraining ? row.sets : '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="muted">
            夜间净流失 = 当天晨重 − 前一天睡前重，缺一个就留空；它只是水分与胃内容物的差，
            别当成「夜间代谢」。
          </p>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.window-switch {
  display: flex;
  gap: 8px;
}

.legacy-mark {
  color: var(--warn);
}
</style>
