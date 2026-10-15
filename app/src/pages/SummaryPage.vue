<script setup lang="ts">
/**
 * 当日汇总（M5 / FR-500）。
 *
 * 输出与 `scripts/nutrition.py totals` 对齐（见 tests/fixtures-totals.spec.ts）：
 * 六项摄入 / 目标 / 差额 / 占比，加上缺口提示与「不完整」标注。
 */

import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import DateNav from '@/components/DateNav.vue'
import { useDayStore } from '@/store/day'
import { fmtNumber, fmtPercent, fmtSigned } from '@/domain/format'
import { todayIso } from '@/app/date'

const route = useRoute()
const router = useRouter()
const store = useDayStore()

onMounted(async () => {
  const fromRoute = route.params.date
  await store.load(fromRoute ? String(fromRoute) : todayIso())
})

/** 占比条的填充比例：上限类（钠）按 100% 截断，避免超出时条子溢出。 */
function fillPercent(ratio: number): number {
  return Math.max(0, Math.min(100, ratio * 100))
}

function isOver(row: { key: string; ratio: number }): boolean {
  return row.key === 'sodiumMg' ? row.ratio > 1 : row.ratio > 1.1
}
</script>

<template>
  <section class="page">
    <AppHeader
      title="当日汇总"
      subtitle="数值全部来自本地计算，模型只负责写结论。"
      back
    />

    <DateNav :date="store.date" @update:date="store.load" />

    <div v-if="store.summary.incomplete" class="card card-warn">
      <strong>本次汇总不完整</strong>
      <p class="muted">
        有 {{ store.summary.pendingCount }} 条记录还没拿到营养数值（未配置模型或当时离线），
        补齐后会自动重算。
      </p>
    </div>

    <div class="card">
      <h2 class="card-title">摄入 vs 目标</h2>
      <div v-for="row in store.summaryRows" :key="row.key" class="nutrient-row">
        <div class="nutrient-head">
          <span>{{ row.label }}</span>
          <span class="nutrient-numbers">
            {{ fmtNumber(row.intake) }}
            <template v-if="row.target"> / {{ row.key === 'sodiumMg' ? '≤' : '' }}{{ fmtNumber(row.target) }}</template>
            <template v-else> / -</template>
            <span class="nutrient-ratio" :class="{ 'over': isOver(row) }">
              {{ row.target ? fmtPercent(row.ratio) : '-' }}
            </span>
          </span>
        </div>
        <div class="progress">
          <div
            class="progress-fill"
            :class="{ over: isOver(row) }"
            :style="{ width: `${fillPercent(row.ratio)}%` }"
          />
        </div>
        <div v-if="row.target" class="nutrient-diff">
          差额 {{ fmtSigned(row.diff) }}
        </div>
      </div>
      <p v-if="!store.hasTargets" class="muted">
        还没有目标值：在「目标」页完成首次校准后，这里会显示差额与占比。
      </p>
      <van-button v-if="!store.hasTargets" size="small" plain type="primary" block @click="router.push('/targets')">
        去设定目标
      </van-button>
    </div>

    <div class="card">
      <h2 class="card-title">体重</h2>
      <div class="kv">
        <span class="kv-key">晨重</span>
        <span class="kv-value">
          {{ store.day?.weightAmKg === undefined ? '未记录' : `${fmtNumber(store.day.weightAmKg)} kg` }}
        </span>
      </div>
      <div class="kv">
        <span class="kv-key">睡前重</span>
        <span class="kv-value">
          {{ store.day?.weightPmKg === undefined ? '未记录' : `${fmtNumber(store.day.weightPmKg)} kg` }}
        </span>
      </div>
      <div class="kv">
        <span class="kv-key">夜间净流失</span>
        <span class="kv-value">
          {{ store.overnightKg === undefined ? '数据不足' : `${fmtSigned(store.overnightKg)} kg` }}
        </span>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">训练</h2>
      <template v-if="store.summary.training.isRestDay">
        <p class="muted">无训练记录（休息日）。</p>
      </template>
      <template v-else>
        <div class="kv">
          <span class="kv-key">时长</span>
          <span class="kv-value">{{ fmtNumber(store.summary.training.minutes) }} 分钟</span>
        </div>
        <div class="kv">
          <span class="kv-key">组数</span>
          <span class="kv-value">{{ store.summary.training.sets }}</span>
        </div>
        <div class="kv">
          <span class="kv-key">容量负荷</span>
          <span class="kv-value">{{ fmtNumber(store.summary.training.volumeLoadKg) }} kg</span>
        </div>
        <div class="kv">
          <span class="kv-key">涉及肌群</span>
          <span class="kv-value">
            {{
              Object.entries(store.training.muscles)
                .map(([name, sets]) => `${name} ${sets}组`)
                .join('、') || '-'
            }}
          </span>
        </div>
      </template>
    </div>

    <div v-if="store.summary.hints.length" class="card">
      <h2 class="card-title">提示</h2>
      <ul class="hint-list">
        <li v-for="hint in store.summary.hints" :key="hint">{{ hint }}</li>
      </ul>
    </div>

    <div class="actions">
      <van-button type="primary" block @click="router.push('/log/diet')">继续记饮食</van-button>
      <van-button plain type="primary" block @click="router.push('/log/workout')">记训练</van-button>
      <van-button plain block @click="router.push('/today')">返回今日</van-button>
    </div>
  </section>
</template>

<style scoped>
.nutrient-row {
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.nutrient-row:last-child {
  border-bottom: none;
}

.nutrient-head {
  display: flex;
  justify-content: space-between;
  font-size: 14px;
}

.nutrient-numbers {
  font-variant-numeric: tabular-nums;
}

.nutrient-ratio {
  margin-left: 8px;
  color: var(--brand);
}

.nutrient-ratio.over {
  color: var(--danger);
}

.nutrient-diff {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 4px;
}
</style>
