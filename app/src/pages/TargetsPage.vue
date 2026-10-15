<script setup lang="ts">
/**
 * 目标与校准（M9 / FR-900）。
 *
 * 三条硬规则写在这一页里：
 * 1. **不调用模型**：首次估算用 `domain/calibration.ts`（BMR × 活动系数 → 阶段调整）。
 * 2. **改了就留痕**：任何改动都写一行校准记录（日期 / 实测 TDEE / 调整前后 / 依据），
 *    所以这一页只用 `applyCalibration` + `saveTargets`，不直接写库。
 * 3. **幅度与频率有门禁**：单次 ±150 kcal 以内；距上次校准不足 2 周先提示样本可能不足；
 *    超限或频繁调整都需要用户在页面上显式确认（FR-904 / FR-905）。
 */

import { computed, onMounted, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import { useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import { addDays, daysBetween, todayIso } from '@/app/date'
import { getProfile } from '@/data/repositories/profile'
import { listDaysInRange } from '@/data/repositories/days'
import { listIntakeInRange } from '@/data/repositories/intake'
import {
  applyCalibration,
  getTargets,
  listCalibrations,
  putTargets,
  saveTargets
} from '@/data/repositories/targets'
import {
  buildInitialTargets,
  MAX_CALIBRATION_KCAL,
  proposeCalibration,
  resolveSeedWeight
} from '@/domain/calibration'
import { fmtNumber, fmtSigned } from '@/domain/format'
import { sumFacts } from '@/domain/nutrition'
import { roundToTdeeStep } from '@/domain/tdee'
import { buildTrend } from '@/domain/trend'
import type { CalibrationRecord, ProfileRecord, TargetsRecord } from '@/domain/types'

/** 距上次校准不足这个天数时先提示再改（FR-905）。 */
const CALIBRATION_MIN_DAYS = 14
/** 档案里的体重先落一个兜底值，避免「还没称过重」时算不出估算。 */
const WINDOW_DAYS = 28

const router = useRouter()

interface TargetsForm {
  tdeeKcal: string
  kcalTarget: string
  proteinTargetG: string
  fatTargetG: string
  carbTargetG: string
  fiberTargetG: string
  sodiumMaxMg: string
  weeklyTrainingDays: string
  weeklySetsPerMuscle: string
  targetWeightKg: string
  targetRateKgPerWeek: string
  reviewCadence: 'weekly' | 'monthly'
  /** 本次校准依据里的实测 TDEE；留空则沿用已存的 tdeeKcal */
  measuredTdee: string
}

interface PendingChange {
  next: TargetsRecord
  changed: string[]
  deltaKcal: number
  warnings: string[]
  basis: string
}

const targets = shallowRef<TargetsRecord>()
const profile = shallowRef<ProfileRecord>()
const calibrations = ref<CalibrationRecord[]>([])
const seedWeight = ref<{ weightKg?: number; from: string }>({ from: '' })
const latestTdee = ref<{ value: number; step: number; sampleDays: number; confidence: string; warnings: string[] }>()
const form = ref<TargetsForm>(blankForm())
const pending = ref<PendingChange>()
const errorMessage = ref('')
/** 首次读取完成前不渲染表单，避免把空表单填成「没有档案」。 */
const loaded = ref(false)

function blankForm(): TargetsForm {
  return {
    tdeeKcal: '',
    kcalTarget: '',
    proteinTargetG: '',
    fatTargetG: '',
    carbTargetG: '',
    fiberTargetG: '30',
    sodiumMaxMg: '2300',
    weeklyTrainingDays: '',
    weeklySetsPerMuscle: '',
    targetWeightKg: '',
    targetRateKgPerWeek: '',
    reviewCadence: 'weekly',
    measuredTdee: ''
  }
}

function syncForm(record: TargetsRecord): void {
  form.value = {
    tdeeKcal: String(Math.round(record.tdeeKcal)),
    kcalTarget: String(Math.round(record.kcalTarget)),
    proteinTargetG: String(Math.round(record.proteinTargetG)),
    fatTargetG: String(Math.round(record.fatTargetG)),
    carbTargetG: String(Math.round(record.carbTargetG)),
    fiberTargetG: String(Math.round(record.fiberTargetG)),
    sodiumMaxMg: String(Math.round(record.sodiumMaxMg)),
    weeklyTrainingDays: String(record.weeklyTrainingDays),
    weeklySetsPerMuscle: String(record.weeklySetsPerMuscle),
    targetWeightKg: record.targetWeightKg ? String(record.targetWeightKg) : '',
    targetRateKgPerWeek: String(record.targetRateKgPerWeek),
    reviewCadence: record.reviewCadence,
    measuredTdee: ''
  }
}

async function load(): Promise<void> {
  const today = todayIso()
  const [targetsRow, profileRow, rows, intakeRows, records] = await Promise.all([
    getTargets(),
    getProfile(),
    listDaysInRange(addDays(today, -WINDOW_DAYS), today),
    listIntakeInRange(addDays(today, -WINDOW_DAYS), today),
    listCalibrations()
  ])
  targets.value = targetsRow
  profile.value = profileRow
  calibrations.value = records
  seedWeight.value = resolveSeedWeight(
    rows.map((row) => ({
      date: row.date,
      weightAmKg: row.weightAmKg,
      weightPmKg: row.weightPmKg
    })),
    profileRow?.weightKg
  )

  const intakeByDate = new Map<string, typeof intakeRows>()
  for (const row of intakeRows) {
    const bucket = intakeByDate.get(row.date)
    if (bucket) bucket.push(row)
    else intakeByDate.set(row.date, [row])
  }
  const trend = buildTrend({
    days: rows.map((row) => {
      const entries = intakeByDate.get(row.date) ?? []
      return {
        date: row.date,
        weightAmKg: row.weightAmKg,
        weightPmKg: row.weightPmKg,
        intake: sumFacts(entries.map((entry) => entry.computed)),
        hasIntakeRows: entries.length > 0,
        workouts: []
      }
    }),
    targets: {
      kcalTarget: targetsRow?.kcalTarget ?? 0,
      proteinTargetG: targetsRow?.proteinTargetG ?? 0,
      fatTargetG: targetsRow?.fatTargetG ?? 0,
      carbTargetG: targetsRow?.carbTargetG ?? 0,
      fiberTargetG: targetsRow?.fiberTargetG ?? 0,
      sodiumMaxMg: targetsRow?.sodiumMaxMg ?? 0,
      weeklySetsPerMuscle: targetsRow?.weeklySetsPerMuscle
    },
    windowDays: WINDOW_DAYS
  })
  latestTdee.value = trend.tdee.estimate
    ? {
        value: trend.tdee.estimate.tdeeKcal,
        step: roundToTdeeStep(trend.tdee.estimate.tdeeKcal),
        sampleDays: trend.tdee.estimate.sampleDays,
        confidence: trend.tdee.confidence,
        warnings: trend.tdee.warnings
      }
    : undefined

  if (targetsRow) {
    syncForm(targetsRow)
  } else if (estimate.value) {
    syncEstimateForm(estimate.value, targetsRow ?? undefined)
  }
  loaded.value = true
}

onMounted(load)

/** 首次估算（FR-902）：不调模型，全部本地算。 */
const estimate = computed(() => {
  const record = profile.value
  if (!record || seedWeight.value.weightKg === undefined) return undefined
  return buildInitialTargets({ profile: record, weightKg: seedWeight.value.weightKg })
})

/** 首次进入时把估算值填进表单，用户可以直接改（不改也能用）。 */
function syncEstimateForm(base: ReturnType<typeof buildInitialTargets>, existing?: TargetsRecord): void {
  form.value = {
    ...blankForm(),
    tdeeKcal: String(Math.round(base.tdeeKcal)),
    kcalTarget: String(Math.round(base.kcalTarget)),
    proteinTargetG: String(Math.round(base.proteinTargetG)),
    fatTargetG: String(Math.round(base.fatTargetG)),
    carbTargetG: String(Math.round(base.carbTargetG)),
    fiberTargetG: String(Math.round(base.fiberTargetG)),
    sodiumMaxMg: String(Math.round(base.sodiumMaxMg)),
    weeklyTrainingDays: String(base.weeklyTrainingDays),
    weeklySetsPerMuscle: String(base.weeklySetsPerMuscle),
    targetWeightKg: existing?.targetWeightKg ? String(existing.targetWeightKg) : '',
    targetRateKgPerWeek: String(base.targetRateKgPerWeek),
    reviewCadence: existing?.reviewCadence ?? base.reviewCadence
  }
}

const needsProfile = computed(() => !profile.value)

const bmi = computed(() => {
  const record = profile.value
  const weight = seedWeight.value.weightKg
  if (!record?.heightCm || weight === undefined) return undefined
  return weight / (record.heightCm / 100) ** 2
})

const proteinHint = computed(() =>
  bmi.value !== undefined && bmi.value >= 28
    ? `BMI ${bmi.value.toFixed(1)} ≥ 28：蛋白目标建议改用「目标体重 × 2.0~2.2」或「当前体重 × 1.6」重算。`
    : ''
)

/** 第一次写目标：用表单里的值（由估算预填，可改），写完补一行校准记录。 */
async function createTargets(): Promise<void> {
  errorMessage.value = ''
  const base = estimate.value
  if (!base) {
    errorMessage.value = '还缺档案或体重，先在「档案」页填好性别 / 年龄 / 身高 / 体重。'
    return
  }
  const parsed = parseForm()
  if (!parsed) return
  const record = await putTargets({
    tdeeKcal: parsed.tdeeKcal,
    kcalTarget: parsed.kcalTarget,
    proteinTargetG: parsed.proteinTargetG,
    fatTargetG: parsed.fatTargetG,
    carbTargetG: parsed.carbTargetG,
    fiberTargetG: parsed.fiberTargetG,
    sodiumMaxMg: parsed.sodiumMaxMg,
    weeklyTrainingDays: parsed.weeklyTrainingDays,
    weeklySetsPerMuscle: parsed.weeklySetsPerMuscle,
    targetWeightKg: parsed.targetWeightKg,
    targetRateKgPerWeek: parsed.targetRateKgPerWeek,
    reviewCadence: parsed.reviewCadence
  })
  await applyCalibration({
    date: todayIso(),
    measuredTdee: Math.round(base.tdeeKcal),
    kcalAfter: record.kcalTarget,
    basis: `首次目标估算：BMR ${fmtNumber(base.bmr)} × 活动系数 ${base.activityLabel} = TDEE ${fmtNumber(base.tdeeKcal)}；${base.phase} ${fmtSigned(base.adjust * 100)}%`
  })
  showToast({ message: '目标已写入，并留下第一行校准记录', position: 'bottom' })
  pending.value = undefined
  await load()
}

/** 已有目标时点「保存调整」：先算差异，必要时让用户确认，再落库留痕。 */
function requestSave(): void {
  errorMessage.value = ''
  const current = targets.value
  if (!current) return
  const parsed = parseForm()
  if (!parsed) return

  const changed: string[] = []
  const compare = (label: string, before: number, after: number) => {
    if (Math.abs(before - after) > 1e-9) changed.push(`${label} ${fmtNumber(before)} → ${fmtNumber(after)}`)
  }
  compare('热量目标', current.kcalTarget, parsed.kcalTarget)
  compare('蛋白目标', current.proteinTargetG, parsed.proteinTargetG)
  compare('脂肪目标', current.fatTargetG, parsed.fatTargetG)
  compare('碳水目标', current.carbTargetG, parsed.carbTargetG)
  compare('纤维目标', current.fiberTargetG, parsed.fiberTargetG)
  compare('钠上限', current.sodiumMaxMg, parsed.sodiumMaxMg)
  compare('每周训练天数', current.weeklyTrainingDays, parsed.weeklyTrainingDays)
  compare('每肌群组数', current.weeklySetsPerMuscle, parsed.weeklySetsPerMuscle)
  compare('目标体重', current.targetWeightKg, parsed.targetWeightKg)
  compare('目标速率', current.targetRateKgPerWeek, parsed.targetRateKgPerWeek)
  if (current.reviewCadence !== parsed.reviewCadence) changed.push(`复盘节奏 ${current.reviewCadence} → ${parsed.reviewCadence}`)

  if (!changed.length) {
    showToast({ message: '没有改动', position: 'bottom' })
    return
  }

  const deltaKcal = Math.round(parsed.kcalTarget - current.kcalTarget)
  const warnings: string[] = []
  if (deltaKcal) {
    if (Math.abs(deltaKcal) > MAX_CALIBRATION_KCAL) {
      warnings.push(
        `单次调整 ${fmtSigned(deltaKcal)} kcal 超过 ±${MAX_CALIBRATION_KCAL} kcal 的上限（FR-904），需要你显式确认。`
      )
    }
    const daysSince = current.lastCalibrated ? daysBetween(current.lastCalibrated, todayIso()) : undefined
    if (daysSince !== undefined && daysSince < CALIBRATION_MIN_DAYS) {
      warnings.push(`距上次校准只有 ${daysSince} 天（< 2 周），样本可能不足，建议再观察（FR-905）。`)
    }
  }

  const measured = form.value.measuredTdee.trim() || String(Math.round(current.tdeeKcal))
  pending.value = {
    next: { ...current, ...parsed, lastCalibrated: current.lastCalibrated },
    changed,
    deltaKcal,
    warnings,
    basis: `目标页手动调整：${changed.join('；')}；实测 TDEE ${measured} kcal`
  }
}

/** 确认后落库：校准记录 + 其余字段。 */
async function applyPending(): Promise<void> {
  const plan = pending.value
  const current = targets.value
  if (!plan || !current) return
  const measured = Number(form.value.measuredTdee) || current.tdeeKcal
  if (plan.deltaKcal) {
    await applyCalibration({
      date: todayIso(),
      measuredTdee: measured,
      kcalAfter: plan.next.kcalTarget,
      basis: plan.basis
    })
  } else {
    // 没动热量也要留痕（FR-903）：kcalBefore 与 kcalAfter 相同，basis 里写清改了哪些字段
    await applyCalibration({
      date: todayIso(),
      measuredTdee: measured,
      kcalAfter: current.kcalTarget,
      basis: plan.basis
    })
  }
  await saveTargets({
    tdeeKcal: plan.next.tdeeKcal,
    proteinTargetG: plan.next.proteinTargetG,
    fatTargetG: plan.next.fatTargetG,
    carbTargetG: plan.next.carbTargetG,
    fiberTargetG: plan.next.fiberTargetG,
    sodiumMaxMg: plan.next.sodiumMaxMg,
    weeklyTrainingDays: plan.next.weeklyTrainingDays,
    weeklySetsPerMuscle: plan.next.weeklySetsPerMuscle,
    targetWeightKg: plan.next.targetWeightKg,
    targetRateKgPerWeek: plan.next.targetRateKgPerWeek,
    reviewCadence: plan.next.reviewCadence
  })
  pending.value = undefined
  showToast({ message: '已保存并写入校准记录', position: 'bottom' })
  await load()
}

/** 按实测 TDEE 给建议：只在 ±150 kcal 以内自动限幅（FR-904）。 */
function fillSuggestedKcal(measuredTdee: number): void {
  const current = targets.value
  if (!current) return
  const rate = Number(form.value.targetRateKgPerWeek) || current.targetRateKgPerWeek
  const proposal = proposeCalibration(measuredTdee, current.kcalTarget, rate)
  form.value.kcalTarget = String(proposal.kcalTarget)
  form.value.measuredTdee = String(Math.round(measuredTdee))
  form.value.tdeeKcal = String(Math.round(measuredTdee))
  if (proposal.note) showToast({ message: proposal.note, position: 'bottom' })
  requestSave()
}

/** 高体脂时的蛋白重算：当前体重 × 1.6（FR-906）。 */
function recalcProtein(): void {
  const weight = seedWeight.value.weightKg
  if (weight === undefined) return
  form.value.proteinTargetG = String(Math.round(weight * 1.6))
  showToast({ message: '按当前体重 × 1.6 填入蛋白目标', position: 'bottom' })
}

function parseForm(): (TargetsRecord & { reviewCadence: 'weekly' | 'monthly' }) | undefined {
  const num = (value: string) => Number(value.trim())
  const fields: [keyof TargetsForm, string][] = [
    ['tdeeKcal', 'TDEE'],
    ['kcalTarget', '热量目标'],
    ['proteinTargetG', '蛋白目标'],
    ['fatTargetG', '脂肪目标'],
    ['carbTargetG', '碳水目标'],
    ['fiberTargetG', '纤维目标'],
    ['sodiumMaxMg', '钠上限'],
    ['weeklyTrainingDays', '每周训练天数'],
    ['weeklySetsPerMuscle', '每肌群组数']
  ]
  for (const [key, label] of fields) {
    const value = num(String(form.value[key]))
    if (!Number.isFinite(value) || value <= 0) {
      errorMessage.value = `${label}要填一个大于 0 的数字。`
      return undefined
    }
  }
  const targetWeightKg = form.value.targetWeightKg.trim() ? num(form.value.targetWeightKg) : 0
  const targetRateKgPerWeek = num(form.value.targetRateKgPerWeek)
  if (!Number.isFinite(targetWeightKg) || targetWeightKg < 0) {
    errorMessage.value = '目标体重要填一个不小于 0 的数字（不清楚可以先留空）。'
    return undefined
  }
  if (!Number.isFinite(targetRateKgPerWeek)) {
    errorMessage.value = '目标速率要填数字，减脂是负值（例如 -0.39）。'
    return undefined
  }
  return {
    id: 'current',
    tdeeKcal: num(form.value.tdeeKcal),
    kcalTarget: num(form.value.kcalTarget),
    proteinTargetG: num(form.value.proteinTargetG),
    fatTargetG: num(form.value.fatTargetG),
    carbTargetG: num(form.value.carbTargetG),
    fiberTargetG: num(form.value.fiberTargetG),
    sodiumMaxMg: num(form.value.sodiumMaxMg),
    weeklyTrainingDays: num(form.value.weeklyTrainingDays),
    weeklySetsPerMuscle: num(form.value.weeklySetsPerMuscle),
    targetWeightKg,
    targetRateKgPerWeek,
    reviewCadence: form.value.reviewCadence,
    updatedAt: Date.now()
  }
}

const carbPerKg = computed(() => {
  const weight = seedWeight.value.weightKg
  const carb = Number(form.value.carbTargetG)
  if (weight === undefined || !weight || !Number.isFinite(carb)) return undefined
  return carb / weight
})
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader title="目标" subtitle="这里只维护目标值；改任何一项都会写一行校准记录。" back />

    <div v-if="!loaded" class="card">
      <p class="muted">读取中…</p>
    </div>

    <div v-else-if="needsProfile" class="card">
      <h2 class="card-title">先填档案</h2>
      <p class="muted">
        首次估算要用性别、年龄、身高、体重和目标（BMR × 活动系数 → 阶段调整），这些在「档案」页。
      </p>
      <van-button type="primary" block @click="router.push('/profile')">去填档案</van-button>
    </div>

    <div v-else-if="!targets" class="card">
      <h2 class="card-title">首次估算（本地计算，不调用模型）</h2>
      <template v-if="estimate">
        <div class="kv">
          <span class="kv-key">基础代谢 BMR</span>
          <span class="kv-value">{{ fmtNumber(estimate.bmr) }} kcal</span>
        </div>
        <div class="kv">
          <span class="kv-key">活动系数</span>
          <span class="kv-value">{{ estimate.activityLabel }}</span>
        </div>
        <div class="kv">
          <span class="kv-key">TDEE</span>
          <span class="kv-value">{{ fmtNumber(estimate.tdeeKcal) }} kcal</span>
        </div>
        <div class="kv">
          <span class="kv-key">阶段</span>
          <span class="kv-value">{{ estimate.phase }} {{ fmtSigned(estimate.adjust * 100) }}%</span>
        </div>
        <div class="kv">
          <span class="kv-key">用的体重</span>
          <span class="kv-value">{{ seedWeight.from || '-' }}</span>
        </div>
      </template>
      <p v-else class="muted">还没有可用的体重：先在「记身体」里称一次，或把档案里的体重填上。</p>

      <template v-if="estimate">
        <van-field v-model="form.kcalTarget" label="热量目标" type="number" placeholder="等首次估算填好的值" />
        <van-field v-model="form.proteinTargetG" label="蛋白(g)" type="number" />
        <van-field v-model="form.fatTargetG" label="脂肪(g)" type="number" />
        <van-field v-model="form.carbTargetG" label="碳水(g)" type="number" />
        <van-field v-model="form.fiberTargetG" label="纤维(g)" type="number" />
        <van-field v-model="form.sodiumMaxMg" label="钠上限(mg)" type="number" />
        <van-field v-model="form.weeklyTrainingDays" label="每周训练天数" type="number" />
        <van-field v-model="form.weeklySetsPerMuscle" label="每肌群组数" type="number" />
        <van-field v-model="form.targetWeightKg" label="目标体重(kg)" type="number" placeholder="不清楚可以先留空" />
        <van-field v-model="form.targetRateKgPerWeek" label="目标速率(kg/周)" placeholder="-0.39" />
        <van-field v-model="form.tdeeKcal" label="TDEE(kcal)" type="number" />
        <p v-if="proteinHint" class="muted warn-text">{{ proteinHint }}</p>
        <div class="actions">
          <van-button type="primary" block @click="createTargets">写入目标并留痕</van-button>
          <van-button v-if="proteinHint" plain block @click="recalcProtein">按当前体重 × 1.6 重算蛋白</van-button>
        </div>
      </template>
    </div>

    <template v-else>
      <div class="card">
        <h2 class="card-title">当前目标</h2>
        <div class="kv">
          <span class="kv-key">热量</span>
          <span class="kv-value">{{ fmtNumber(targets.kcalTarget) }} kcal</span>
        </div>
        <div class="kv">
          <span class="kv-key">蛋白 / 脂肪 / 碳水</span>
          <span class="kv-value">
            {{ fmtNumber(targets.proteinTargetG) }} / {{ fmtNumber(targets.fatTargetG) }} /
            {{ fmtNumber(targets.carbTargetG) }} g
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">纤维 / 钠上限</span>
          <span class="kv-value">
            {{ fmtNumber(targets.fiberTargetG) }} g / ≤{{ fmtNumber(targets.sodiumMaxMg) }} mg
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">训练</span>
          <span class="kv-value">
            每周 {{ targets.weeklyTrainingDays }} 天 · 每肌群 {{ targets.weeklySetsPerMuscle }} 组
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">目标体重 / 速率</span>
          <span class="kv-value">
            {{ targets.targetWeightKg ? `${fmtNumber(targets.targetWeightKg)} kg` : '-' }} ·
            {{ fmtSigned(targets.targetRateKgPerWeek) }} kg/周
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">上次校准</span>
          <span class="kv-value">{{ targets.lastCalibrated ?? '-' }}</span>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">调整目标</h2>
        <van-field v-model="form.kcalTarget" label="热量目标" type="number" />
        <van-field v-model="form.proteinTargetG" label="蛋白(g)" type="number" />
        <van-field v-model="form.fatTargetG" label="脂肪(g)" type="number" />
        <van-field v-model="form.carbTargetG" label="碳水(g)" type="number" />
        <van-field v-model="form.fiberTargetG" label="纤维(g)" type="number" />
        <van-field v-model="form.sodiumMaxMg" label="钠上限(mg)" type="number" />
        <van-field v-model="form.weeklyTrainingDays" label="每周训练天数" type="number" />
        <van-field v-model="form.weeklySetsPerMuscle" label="每肌群组数" type="number" />
        <van-field v-model="form.targetWeightKg" label="目标体重(kg)" type="number" />
        <van-field v-model="form.targetRateKgPerWeek" label="目标速率(kg/周)" />
        <van-field v-model="form.tdeeKcal" label="TDEE(kcal)" type="number" />
        <van-field v-model="form.measuredTdee" label="本次实测 TDEE" type="number" placeholder="留空则沿用上面的 TDEE" />
        <p v-if="carbPerKg !== undefined && carbPerKg < 1.5" class="muted warn-text">
          碳水偏低（{{ carbPerKg.toFixed(1) }} g/kg），热量目标或蛋白目标可能需要重新权衡。
        </p>
        <p v-if="proteinHint" class="muted warn-text">{{ proteinHint }}</p>
        <div class="actions">
          <van-button type="primary" block @click="requestSave">保存调整</van-button>
          <van-button v-if="proteinHint" plain block @click="recalcProtein">按当前体重 × 1.6 重算蛋白</van-button>
        </div>
      </div>

      <div class="card">
        <h2 class="card-title">实测 TDEE（反推）</h2>
        <template v-if="latestTdee">
          <div class="kv">
            <span class="kv-key">实测 TDEE</span>
            <span class="kv-value">{{ fmtNumber(latestTdee.value) }} kcal · {{ latestTdee.confidence }}</span>
          </div>
          <div class="kv">
            <span class="kv-key">样本</span>
            <span class="kv-value">{{ latestTdee.sampleDays }} 天（同时有体重与饮食记录）</span>
          </div>
          <div class="kv">
            <span class="kv-key">建议取值</span>
            <span class="kv-value">{{ fmtNumber(latestTdee.step) }} kcal（50 的整数倍）</span>
          </div>
          <ul v-if="latestTdee.warnings.length" class="hint-list">
            <li v-for="warning in latestTdee.warnings" :key="warning">{{ warning }}</li>
          </ul>
          <div class="actions">
            <van-button plain type="primary" block @click="fillSuggestedKcal(latestTdee.value)">
              按实测 TDEE 生成建议（自动限幅 ±{{ MAX_CALIBRATION_KCAL }} kcal）
            </van-button>
          </div>
        </template>
        <p v-else class="muted">
          有效数据不足，暂时反推不出 TDEE：至少需要 7 天同时有体重与饮食记录。
        </p>
        <p class="muted">
          建议值 = 实测 TDEE + 目标速率 × 7700 / 7；单次最多挪 ±{{ MAX_CALIBRATION_KCAL }} kcal（FR-904）。
        </p>
      </div>
    </template>

    <div v-if="pending" class="card card-confirm">
      <h2 class="card-title">确认这次调整</h2>
      <ul class="hint-list">
        <li v-for="item in pending.changed" :key="item">{{ item }}</li>
      </ul>
      <ul v-if="pending.warnings.length" class="hint-list warn-text">
        <li v-for="item in pending.warnings" :key="item">{{ item }}</li>
      </ul>
      <p class="muted">确认后会写入一行校准记录（日期 / 实测 TDEE / 调整前后 / 依据）。</p>
      <div class="actions">
        <van-button type="primary" block @click="applyPending">确认并写入校准记录</van-button>
        <van-button plain block @click="pending = undefined">取消</van-button>
      </div>
    </div>

    <p v-if="errorMessage" class="muted warn-text">{{ errorMessage }}</p>

    <div class="card">
      <h2 class="card-title">校准记录</h2>
      <p v-if="!calibrations.length" class="muted">还没有校准记录。</p>
      <div v-for="row in calibrations" :key="row.id" class="calib-row">
        <div class="kv">
          <span class="kv-key">{{ row.date }}</span>
          <span class="kv-value">
            {{ fmtNumber(row.kcalBefore) }} → {{ fmtNumber(row.kcalAfter) }} kcal
            （{{ fmtSigned(row.kcalAfter - row.kcalBefore) }}）
          </span>
        </div>
        <p class="muted">
          实测 TDEE {{ fmtNumber(row.measuredTdee) }} kcal · {{ row.basis }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.card-confirm {
  border-color: var(--warn);
  background: #fffaf3;
}

.calib-row {
  border-bottom: 1px dashed var(--border);
  padding-bottom: 6px;
  margin-bottom: 6px;
}

.calib-row:last-child {
  border-bottom: none;
  margin-bottom: 0;
}

.calib-row .kv {
  border-bottom: none;
}
</style>
