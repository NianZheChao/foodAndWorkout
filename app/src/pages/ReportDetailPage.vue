<script setup lang="ts">
/**
 * 报告详情（T3.3 / M7）。
 *
 * 版式按「数值 / 文字」分区（§8.3 B）：上方永远是本地算出来的数；
 * 模型写的文字单独一块，被数字守卫标出来的数字就地高亮成「待核对」。
 * 文字可以直接编辑（`editedByUser` 留痕），数值区不可编辑 —— 它不是文案，是计算结果。
 */

import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import { generateReport, saveEditedContent } from '@/application/report'
import { getReport } from '@/data/repositories/reports'
import { confirmOverBudget } from '@/app/budget'
import { buildNumberWhitelist } from '@/domain/reportGuard'
import { coverageWarning } from '@/domain/reportDigest'
import { fmtNumber, fmtPercent, fmtSigned } from '@/domain/format'
import type { ReportRecord } from '@/domain/types'

const route = useRoute()
const router = useRouter()

const report = ref<ReportRecord>()
const loaded = ref(false)
const busy = ref(false)
const editing = ref(false)
const draftSummary = ref('')
const draftActions = ref('')

async function load(): Promise<void> {
  report.value = await getReport(String(route.params.id))
  if (report.value?.content) {
    draftSummary.value = report.value.content.summary
    draftActions.value = report.value.content.actions.join('\n')
  }
  loaded.value = true
}

onMounted(load)

const digest = computed(() => report.value?.digest)
const coverageNote = computed(() => (digest.value ? coverageWarning(digest.value) : undefined))
const flagged = computed(() => report.value?.flaggedNumbers ?? [])

/** 把正文按「待核对数字」切开，数字单独包一层做高亮。 */
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

async function regenerate(): Promise<void> {
  const current = report.value
  if (!current) return
  busy.value = true
  try {
    const outcome = await generateReport({ type: current.type, endDate: current.periodEnd }, { confirm: confirmOverBudget })
    if (outcome.report) {
      showToast({ message: '已生成新版本，旧版本留在列表里', position: 'bottom' })
      await router.push(`/reports/${outcome.report.id}`)
    }
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  const current = report.value
  if (!current?.content) return
  busy.value = true
  try {
    const saved = await saveEditedContent(current.id, {
      ...current.content,
      summary: draftSummary.value.trim(),
      actions: draftActions.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    })
    if (saved) {
      report.value = saved
      editing.value = false
      showToast({ message: '已保存你的修改（留痕：已人工编辑）', position: 'bottom' })
    }
  } finally {
    busy.value = false
  }
}

/** 这次的文字里有多少个数是「摘要里能对上的」，写在说明里让用户知道核对范围。 */
const whitelistSize = computed(() => (digest.value ? buildNumberWhitelist(digest.value).size : 0))
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader
      :title="report ? `${report.label} ${report.type === 'weekly' ? '周报' : '月报'}` : '报告'"
      :subtitle="report ? `${report.periodStart} ~ ${report.periodEnd}` : ''"
      back
    />

    <div v-if="!loaded" class="card"><p class="muted">读取中…</p></div>

    <div v-else-if="!report" class="card">
      <p class="empty">这份报告不在本机（可能已被清理）。</p>
      <van-button plain type="primary" block @click="router.push('/reports')">回报告列表</van-button>
    </div>

    <template v-else>
      <div v-if="coverageNote" class="card card-warn">
        <strong>样本不足</strong>
        <p class="muted">{{ coverageNote }}</p>
      </div>

      <div v-if="report.status === 'pending'" class="card card-warn">
        <h2 class="card-title">文字还没生成</h2>
        <p class="muted">
          下面这些数已经算好并保存在本机；配好模型后点「重新生成」，会新建一版带文字的报告。
        </p>
      </div>

      <div class="card">
        <h2 class="card-title">数值区（本地计算）</h2>
        <template v-if="digest">
          <div class="kv">
            <span class="kv-key">区间</span>
            <span class="kv-value">
              {{ digest.period.start }} ~ {{ digest.period.end }} · {{ digest.period.days }} 天
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">覆盖</span>
            <span class="kv-value">
              饮食 {{ digest.coverage.daysWithIntake }} 天（{{ fmtPercent(digest.coverage.ratio) }}）·
              体重 {{ digest.coverage.daysWithWeight }} 天
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">日均摄入</span>
            <span class="kv-value">
              {{ fmtNumber(digest.intake.avgKcal) }} / {{ fmtNumber(digest.intake.target) }} kcal ·
              蛋白 {{ fmtNumber(digest.intake.avgProteinG) }} / {{ fmtNumber(digest.intake.proteinTargetG) }} g
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">达标天数</span>
            <span class="kv-value">
              热量 {{ digest.intake.kcalHitDays }}/{{ digest.intake.recordedDays }} ·
              蛋白 {{ digest.intake.proteinHitDays }}/{{ digest.intake.recordedDays }}
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">钠 / 纤维</span>
            <span class="kv-value">
              钠日均 {{ fmtNumber(digest.intake.avgSodiumMg) }}（≤{{ fmtNumber(digest.intake.sodiumMaxMg) }}，超标
              {{ digest.intake.sodiumOverDays }} 天）· 纤维日均 {{ fmtNumber(digest.intake.avgFiberG) }}（目标
              {{ fmtNumber(digest.intake.fiberTargetG) }}，达标 {{ digest.intake.fiberHitDays }} 天）
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">体重</span>
            <span class="kv-value">
              <template v-if="digest.weight.changeKg !== undefined">
                {{ fmtSigned(digest.weight.changeKg) }} kg（{{ fmtSigned(digest.weight.changePctPerWeek ?? 0) }}% /周）
                · 7 日均线 {{ fmtNumber(digest.weight.ma7) }} kg
              </template>
              <template v-else>数据不足（至少 2 天有体重）</template>
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">训练</span>
            <span class="kv-value">
              {{ digest.training.days }} 天 / 目标 {{ digest.training.targetDays }} 天 ·
              {{ fmtNumber(digest.training.minutes) }} 分钟 · {{ digest.training.sets }} 组 ·
              容量 {{ fmtNumber(digest.training.volumeLoadKg) }} kg
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">各肌群组数</span>
            <span class="kv-value">
              {{ digest.training.byMuscle.map((row) => `${row.muscle} ${row.sets}`).join('、') || '-' }}
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">训练强度 / 有氧</span>
            <span class="kv-value">
              <template v-if="digest.training.rpeAvg !== undefined">
                RPE 均值 {{ fmtNumber(digest.training.rpeAvg) }}<template v-if="digest.training.highRpeEntries">
                  （≥8 有 {{ digest.training.highRpeEntries }} 条）</template>
                ·
              </template>
              有氧估算 {{ fmtNumber(digest.training.burnKcal) }} kcal
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">恢复（睡眠 / 精力 / 酸痛）</span>
            <span class="kv-value">
              <template v-if="digest.recovery.sleepDays">
                睡眠均值 {{ fmtNumber(digest.recovery.avgSleepHours) }} h（{{ digest.recovery.sleepDays }} 天有记录<template
                  v-if="digest.recovery.shortSleepDays"
                >，&lt;6h {{ digest.recovery.shortSleepDays }} 天</template>）
              </template>
              <template v-else>无睡眠记录</template>
              ·
              <template v-if="digest.recovery.ratedDays">
                自评 {{ digest.recovery.ratedDays }} 天（低精力 {{ digest.recovery.lowEnergyDays ?? 0 }} ·
                高酸痛 {{ digest.recovery.highSorenessDays ?? 0 }}）
              </template>
              <template v-else>无自评</template>
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">当前目标 / 上次校准</span>
            <span class="kv-value">
              {{ fmtNumber(digest.currentTargets.kcalTarget) }} kcal ·
              {{ digest.currentTargets.lastCalibrated ?? '未校准' }}
            </span>
          </div>
          <div class="kv">
            <span class="kv-key">实测 TDEE</span>
            <span class="kv-value">
              <template v-if="digest.tdee">
                {{ fmtNumber(digest.tdee.value) }} kcal（{{ digest.tdee.confidence }}，{{ digest.tdee.sampleDays }} 天样本）
              </template>
              <template v-else>样本不足（至少 7 天同时有体重与饮食）</template>
            </span>
          </div>
          <div v-if="digest.previousDigest?.numbers" class="kv">
            <span class="kv-key">上一期（{{ digest.previousDigest.period }}）</span>
            <span class="kv-value">
              日均热量 {{ fmtNumber(digest.previousDigest.numbers.avgKcal) }} · 训练
              {{ digest.previousDigest.numbers.trainingDays }} 天 · 容量
              {{ fmtNumber(digest.previousDigest.numbers.volumeLoadKg) }} kg<template
                v-if="digest.previousDigest.numbers.weightChangeKg !== undefined"
              > · 体重 {{ fmtSigned(digest.previousDigest.numbers.weightChangeKg) }} kg</template>
            </span>
          </div>
        </template>
      </div>

      <div v-if="report.content" class="card">
        <div class="card-head">
          <h2 class="card-title">文字区（模型写）</h2>
          <span v-if="report.editedByUser" class="tag">已人工编辑</span>
        </div>
        <p class="muted">
          模型只看了上面那份摘要。被标成<span class="flagged">待核对</span>的数字在摘要里找不到出处。
          （可核对数字 {{ whitelistSize }} 个）
        </p>

        <template v-if="editing">
          <van-field v-model="draftSummary" label="总结" type="textarea" rows="3" autosize />
          <van-field v-model="draftActions" label="行动项" type="textarea" rows="4" autosize placeholder="一行一条" />
          <div class="actions">
            <van-button type="primary" block :loading="busy" @click="save">保存修改</van-button>
            <van-button plain block @click="editing = false">取消</van-button>
          </div>
        </template>

        <template v-else>
          <p class="report-summary">
            <template v-for="(part, index) in segments(report.content.summary)" :key="index">
              <span v-if="part.flagged" class="flagged">{{ part.text }}</span>
              <template v-else>{{ part.text }}</template>
            </template>
          </p>
          <div class="kv">
            <span class="kv-key">训练</span>
            <span class="kv-value">{{ report.content.training.assessment }}</span>
          </div>
          <div class="kv">
            <span class="kv-key">饮食</span>
            <span class="kv-value">{{ report.content.diet.assessment }}</span>
          </div>
          <ul v-if="report.content.findings.length" class="hint-list">
            <li v-for="(item, index) in report.content.findings" :key="index">
              <span class="tag">{{ item.kind === 'fact' ? '事实' : '推断' }}</span>
              <template v-for="(part, partIndex) in segments(item.text)" :key="partIndex">
                <span v-if="part.flagged" class="flagged">{{ part.text }}</span>
                <template v-else>{{ part.text }}</template>
              </template>
            </li>
          </ul>
          <template v-if="report.content.issues.length">
            <h2 class="card-title">问题</h2>
            <ul class="hint-list">
              <li v-for="issue in report.content.issues" :key="issue">{{ issue }}</li>
            </ul>
          </template>
          <template v-if="report.content.actions.length">
            <h2 class="card-title">行动项</h2>
            <ul class="hint-list">
              <li v-for="action in report.content.actions" :key="action">{{ action }}</li>
            </ul>
          </template>
          <div class="kv">
            <span class="kv-key">校准建议</span>
            <span class="kv-value">
              <template v-if="report.content.calibration.recommended">
                {{ fmtSigned(report.content.calibration.deltaKcal) }} kcal
              </template>
              <template v-else>本次不建议调整</template>
            </span>
          </div>
          <p v-if="report.content.calibration.rationale" class="muted">
            {{ report.content.calibration.rationale }}
          </p>
          <p class="muted">{{ report.content.disclaimer }}</p>
          <p class="muted">模型：{{ report.model ?? '-' }} · 契约版本 v{{ report.taskVersion ?? '-' }}</p>
        </template>
      </div>

      <div class="actions">
        <van-button v-if="report.content" plain type="primary" block @click="editing = !editing">
          {{ editing ? '退出编辑' : '编辑文字' }}
        </van-button>
        <van-button plain block :loading="busy" @click="regenerate">重新生成（保留这一版）</van-button>
        <van-button plain block @click="router.push('/reports')">回报告列表</van-button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.report-summary {
  margin: 10px 0;
  font-size: 15px;
  line-height: 1.7;
}

.flagged {
  background: #fff3cd;
  border-bottom: 1px dashed var(--accent);
  padding: 0 2px;
}
</style>
