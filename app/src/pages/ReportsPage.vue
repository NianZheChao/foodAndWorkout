<script setup lang="ts">
/**
 * 报告列表（T3.3 / M7 FR-700）。
 *
 * 生成分两步走，界面上也说清楚：**数值区本地算、立即落库**，文字区等模型。
 * 没配模型也能先生成一份只有数值的报告（§9.3），配好模型再重新生成文字。
 * 「重新生成」永远新建一条记录，旧版本留在列表里（FR-710）。
 */

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import { generateReport } from '@/application/report'
import { listReports } from '@/data/repositories/reports'
import { fmtNumber, fmtPercent } from '@/domain/format'
import { coverageWarning, periodOf } from '@/domain/reportDigest'
import { todayIso } from '@/app/date'
import { confirmOverBudget } from '@/app/budget'
import type { ReportRecord, ReportType } from '@/domain/types'

const router = useRouter()
const reports = ref<ReportRecord[]>([])
const busy = ref<ReportType>()
const notice = ref('')
const loaded = ref(false)

const today = todayIso()
const thisWeek = computed(() => periodOf('weekly', today))
const thisMonth = computed(() => periodOf('monthly', today))

async function load(): Promise<void> {
  reports.value = await listReports()
  loaded.value = true
}

onMounted(load)

async function generate(type: ReportType): Promise<void> {
  busy.value = type
  notice.value = ''
  try {
    const outcome = await generateReport({ type, endDate: today }, { confirm: confirmOverBudget })
    if (outcome.ok && outcome.report) {
      await router.push(`/reports/${outcome.report.id}`)
      return
    }
    // 模型没成功也把数值区存下来了，告诉用户它还在，别以为白点了
    const reason = outcome.failure?.message ?? '生成失败'
    notice.value = `数值区已经算好并保存，但文字没生成：${reason}。配好模型后重新生成即可。`
    if (outcome.notices.length) notice.value += `（${outcome.notices.join('；')}）`
    await load()
  } finally {
    busy.value = undefined
  }
}

function statusLabel(row: ReportRecord): string {
  if (row.status === 'ready') return row.editedByUser ? '已人工编辑' : '文字已生成'
  if (row.status === 'pending') return '待生成文字'
  return '草稿'
}

async function regenerate(row: ReportRecord): Promise<void> {
  busy.value = row.type
  try {
    const outcome = await generateReport({ type: row.type, endDate: row.periodEnd }, { confirm: confirmOverBudget })
    if (outcome.report) showToast({ message: '已生成新版本，旧版本保留在列表里', position: 'bottom' })
    await load()
  } finally {
    busy.value = undefined
  }
}
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader title="报告" subtitle="数值全部本地计算；结论由模型写，数字不许编。" />

    <div class="card">
      <h2 class="card-title">生成</h2>
      <p class="card-note muted">
        数值区（均值、达标率、体重变化、训练容量）本地算完就存；文字区要模型，没配也能先生成数值。
      </p>
      <div class="entry-grid">
        <van-button type="primary" :loading="busy === 'weekly'" @click="generate('weekly')">
          本周（{{ thisWeek.label }}）
        </van-button>
        <van-button plain type="primary" :loading="busy === 'monthly'" @click="generate('monthly')">
          本月（{{ thisMonth.label }}）
        </van-button>
      </div>
      <p v-if="notice" class="muted warn-text">{{ notice }}</p>
    </div>

    <div v-if="!loaded" class="card">
      <p class="muted">读取中…</p>
    </div>

    <div v-else-if="!reports.length" class="card">
      <p class="empty">还没有报告。先生成一份本周的试试。</p>
    </div>

    <div v-else class="card">
      <h2 class="card-title">历史报告</h2>
      <div v-for="row in reports" :key="row.id" class="report-row">
        <div class="report-head">
          <div>
            <div class="report-label">
              {{ row.label }}
              <span class="tag">{{ row.type === 'weekly' ? '周报' : '月报' }}</span>
              <span class="tag">{{ statusLabel(row) }}</span>
            </div>
            <div class="report-meta">
              {{ row.periodStart }} ~ {{ row.periodEnd }} ·
              日均 {{ fmtNumber(row.digest.intake.avgKcal) }} kcal ·
              训练 {{ row.digest.training.days }} 天
            </div>
            <div class="report-meta">
              覆盖 {{ row.digest.coverage.daysWithIntake }}/{{ row.digest.period.days }} 天（{{
                fmtPercent(row.digest.coverage.ratio)
              }}）
              <span v-if="coverageWarning(row.digest)" class="warn-text"> · 样本不足</span>
              <span v-if="row.flaggedNumbers?.length" class="warn-text">
                · {{ row.flaggedNumbers.length }} 个待核对数字
              </span>
            </div>
          </div>
        </div>
        <div class="report-actions">
          <van-button size="small" type="primary" @click="router.push(`/reports/${row.id}`)">查看</van-button>
          <van-button size="small" plain :loading="busy === row.type" @click="regenerate(row)">
            重新生成
          </van-button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.report-row {
  padding: 10px 0;
  border-bottom: 1px dashed var(--border);
}

.report-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.report-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
}

.report-meta {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.report-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
