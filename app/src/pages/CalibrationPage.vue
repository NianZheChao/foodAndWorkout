<script setup lang="ts">
/**
 * 校准向导（T3.5 / §6.7）。
 *
 * 这一页把「校准」拆成三段，顺序就是阅读顺序：
 * 1. **本地数字**：实测 TDEE 与样本、近 4 周均线与变化率、平均摄入与达标率、当前目标、距上次校准 ——
 *    全部本地算、不可编辑（与报告数值区同一条纪律）；
 * 2. **本地建议**：`proposeCalibration` 的口径（±150 kcal 限幅），不需要模型；
 * 3. **AI 复核**：一次调用给出方向 / 幅度 / 理由，过本地三道门禁（样本 / 频率 / 幅度）。
 *
 * 关键约束：**AI 复核不落库**，只有用户点「采纳」时才 `applyCalibration`（写目标 + 留一行校准记录）；
 * 被门禁拦下时不给「采纳」按钮，只说明原因。没配模型 / 模型失败时，第 1、2 段照常可用（§9.3）。
 */

import { computed, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import { useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import { todayIso } from '@/app/date'
import { confirmOverBudget } from '@/app/budget'
import {
  buildCalibrationReviewInput,
  reviewCalibration,
  CALIBRATION_WINDOW_DAYS,
  type CalibrationReviewOutcome
} from '@/application/calibration'
import { MAX_CALIBRATION_KCAL } from '@/domain/calibration'
import { CALIBRATION_MIN_DAYS, localProposalOf, type CalibrationReviewInput } from '@/domain/calibrationReview'
import { fmtNumber, fmtSigned } from '@/domain/format'
import { getModelConfig, isModelConfigured } from '@/data/repositories/modelConfig'
import { applyCalibration, getTargets } from '@/data/repositories/targets'

const router = useRouter()

const input = ref<CalibrationReviewInput>()
const outcome = ref<CalibrationReviewOutcome>()
const hasTargets = ref(false)
const configured = ref(false)
const loaded = ref(false)
const busy = ref(false)
const notice = ref('')

async function load(): Promise<void> {
  configured.value = isModelConfigured(await getModelConfig())
  hasTargets.value = !!(await getTargets())
  input.value = await buildCalibrationReviewInput(todayIso())
  loaded.value = true
}

onMounted(load)

/** 本地建议：不花钱、不需要模型，任何时候都算得出来（没样本时 `undefined`）。 */
const local = computed(() => outcome.value?.local ?? (input.value ? localProposalOf(input.value) : undefined))
const flagged = computed(() => outcome.value?.flagged ?? [])
const tdee = computed(() => input.value?.tdee)
const lastCalibrationLabel = computed(() => {
  const last = input.value?.lastCalibration
  if (!last) return '没有校准记录'
  return `${last.date}（${last.daysSince} 天前）`
})

function segments(text: string): { text: string; flagged: boolean }[] {
  if (!flagged.value.length) return [{ text, flagged: false }]
  const pattern = new RegExp(`(${flagged.value.map((item) => item.replace('.', '\\.')).join('|')})`, 'g')
  const parts: { text: string; flagged: boolean }[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: text.slice(last, index), flagged: false })
    parts.push({ text: match[0], flagged: true })
    last = index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), flagged: false })
  return parts
}

async function generate(): Promise<void> {
  if (!input.value) return
  busy.value = true
  notice.value = ''
  try {
    const result = await reviewCalibration(input.value, { confirm: confirmOverBudget })
    outcome.value = result
    if (!result.ok) {
      notice.value = `这次没能生成 AI 复核（${result.failure?.message ?? '未知原因'}）。下面的本地建议照常可用。`
      if (!configured.value) notice.value += '先去模型设置把接口填上。'
    }
  } finally {
    busy.value = false
  }
}

/** 采纳 = 写目标 + 留一行校准记录（`applyCalibration`），然后回目标页看结果。 */
async function adopt(): Promise<void> {
  const current = input.value
  const content = outcome.value?.content
  if (!current || !content || !current.tdee) return
  const measured = current.tdee.value
  await applyCalibration({
    date: current.date,
    measuredTdee: measured,
    kcalAfter: current.currentTargets.kcalTarget + content.deltaKcal,
    basis: `AI 复核（契约 v${outcome.value?.taskVersion ?? 1}）：${content.rationale.slice(0, 80)}；实测 TDEE ${measured} kcal`
  })
  showToast({ message: '已采纳，目标已更新并留下校准记录', position: 'bottom' })
  await router.push('/targets')
}
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader
      title="校准向导"
      subtitle="数字本地算、模型只给判断；采纳才会写目标"
      back
    />

    <div v-if="!loaded" class="card">
      <p class="muted">读取中…</p>
    </div>

    <template v-else-if="input">
      <div v-if="!hasTargets" class="card card-warn">
        <h2 class="card-title">还没有目标值</h2>
        <p class="muted">先去目标页写入一份目标，再回来做校准。</p>
        <van-button type="primary" block @click="router.push('/targets')">去目标页</van-button>
      </div>

      <!-- 第 1 段：本地数字（数值区不可编辑） -->
      <div class="card">
        <h2 class="card-title">本地数字（近 {{ CALIBRATION_WINDOW_DAYS }} 天）</h2>
        <template v-if="tdee">
          <div class="kv">
            <span class="kv-key">实测 TDEE</span>
            <span class="kv-value">{{ fmtNumber(tdee.value) }} kcal · {{ tdee.confidence }}</span>
          </div>
          <div class="kv">
            <span class="kv-key">TDEE 样本</span>
            <span class="kv-value">{{ tdee.sampleDays }} 天（同时有体重与饮食记录）</span>
          </div>
        </template>
        <p v-else class="muted">
          有效数据不足，暂时反推不出 TDEE：至少需要 7 天同时有体重与饮食记录。
        </p>
        <div class="kv">
          <span class="kv-key">体重均线</span>
          <span class="kv-value">
            {{ input.weight.ma7 === undefined ? '-' : `${fmtNumber(input.weight.ma7)} kg` }}
            <template v-if="input.weight.changeKg !== undefined">
              · 变化 {{ fmtSigned(input.weight.changeKg) }} kg
            </template>
            <template v-if="input.weight.changePctPerWeek !== undefined">
              （{{ fmtSigned(input.weight.changePctPerWeek) }}%/周）
            </template>
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">平均摄入</span>
          <span class="kv-value">
            {{ fmtNumber(input.intake.avgKcal) }} kcal（目标 {{ fmtNumber(input.intake.target) }}）
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">记录覆盖</span>
          <span class="kv-value">
            {{ input.intake.recordedDays }}/{{ input.window.days }} 天
            （{{ Math.round(input.intake.ratio * 100) }}%）
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">达标天数</span>
          <span class="kv-value">
            热量 {{ input.intake.kcalHitDays }} 天 · 蛋白 {{ input.intake.proteinHitDays }} 天
          </span>
        </div>
        <div class="kv">
          <span class="kv-key">当前热量目标</span>
          <span class="kv-value">{{ fmtNumber(input.currentTargets.kcalTarget) }} kcal</span>
        </div>
        <div class="kv">
          <span class="kv-key">距上次校准</span>
          <span class="kv-value">{{ lastCalibrationLabel }}</span>
        </div>
      </div>

      <!-- 第 2 段：本地建议（不需要模型） -->
      <div class="card">
        <h2 class="card-title">本地建议（不需要模型）</h2>
        <template v-if="local">
          <div class="kv">
            <span class="kv-key">建议热量目标</span>
            <span class="kv-value">
              {{ fmtNumber(local.kcalTarget) }} kcal（{{ fmtSigned(local.deltaKcal) }}）
            </span>
          </div>
          <p v-if="local.note" class="muted warn-text">{{ local.note }}</p>
        </template>
        <p v-else class="muted">样本不足，本地也算不出建议 —— 先把记录补齐（尤其体重与饮食在同一天）。</p>
        <p class="muted">
          口径：实测 TDEE + 目标速率 × 7700 / 7；单次最多挪 ±{{ MAX_CALIBRATION_KCAL }} kcal（FR-904）。
        </p>
      </div>

      <!-- 第 3 段：AI 复核 -->
      <div class="card">
        <h2 class="card-title">AI 复核</h2>
        <p v-if="notice" class="muted warn-text">{{ notice }}</p>

        <template v-if="outcome?.ok && outcome.content">
          <ul v-if="outcome.notices.length" class="hint-list warn-text">
            <li v-for="item in outcome.notices" :key="item">{{ item }}</li>
          </ul>

          <template v-if="!outcome.blocked">
            <div class="kv">
              <span class="kv-key">方向 / 幅度</span>
              <span class="kv-value">
                {{ outcome.content.direction }} {{ fmtSigned(outcome.content.deltaKcal) }} kcal
              </span>
            </div>
            <div class="kv">
              <span class="kv-key">把握程度</span>
              <span class="kv-value">{{ outcome.content.confidence }}</span>
            </div>
            <p>
              <template v-for="(part, index) in segments(outcome.content.rationale)" :key="index">
                <span v-if="part.flagged" class="flagged">{{ part.text }}</span>
                <template v-else>{{ part.text }}</template>
              </template>
            </p>
            <template v-if="outcome.content.watchItems.length">
              <h2 class="card-title">接下来盯这几项</h2>
              <ul class="hint-list">
                <li v-for="item in outcome.content.watchItems" :key="item">
                  <template v-for="(part, index) in segments(item)" :key="index">
                    <span v-if="part.flagged" class="flagged">{{ part.text }}</span>
                    <template v-else>{{ part.text }}</template>
                  </template>
                </li>
              </ul>
            </template>
            <p v-if="flagged.length" class="muted warn-text">
              有 {{ flagged.length }} 处数字在本地数字里找不到出处，已高亮，请自行核对。
            </p>
          </template>

          <template v-else>
            <p class="muted">被本地门禁拦下，这次不提供「采纳」。模型的原始说法如下（仅供参考）：</p>
            <p class="muted">
              <template v-for="(part, index) in segments(outcome.content.rationale)" :key="index">
                <span v-if="part.flagged" class="flagged">{{ part.text }}</span>
                <template v-else>{{ part.text }}</template>
              </template>
            </p>
          </template>
        </template>

        <p v-else-if="!configured" class="muted">
          还没配模型：本地数字与本地建议照常可用，AI 复核需要先在「模型设置」里填好接口。
        </p>

        <div class="actions">
          <van-button type="primary" block :disabled="!configured" :loading="busy" @click="generate">
            生成校准建议（会调用一次模型）
          </van-button>
          <van-button v-if="!configured" plain block @click="router.push('/settings/model')">去模型设置</van-button>
          <van-button
            v-if="outcome?.ok && outcome.content && !outcome.blocked && hasTargets"
            type="success"
            block
            @click="adopt"
          >
            采纳（写入目标并留一行校准记录）
          </van-button>
        </div>

        <p v-if="outcome?.ok" class="muted">
          模型：{{ outcome.model ?? '-' }} · 契约版本 v{{ outcome.taskVersion ?? '-' }} · 门禁与幅度校验：本地
        </p>
        <p class="muted">频率门禁：距上次校准不足 {{ CALIBRATION_MIN_DAYS }} 天时只建议再观察（FR-905）。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.flagged {
  background: #fff3cd;
  border-bottom: 1px dashed var(--accent);
  padding: 0 2px;
}
</style>
