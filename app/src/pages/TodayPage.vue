<script setup lang="ts">
/**
 * 今日（M0 / M5）：一眼看完今天的状态，并进入记录流程。
 *
 * 三块内容：进度（热量 / 蛋白 / 体重 / 训练）、记录入口、待办与提示。
 * 数字全部来自 `store` 的本地汇总；这里只负责排版，不做任何计算。
 */

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import { useDayStore } from '@/store/day'
import { runQueue } from '@/application/queue'
import { fmtNumber, fmtPercent } from '@/domain/format'
import { formatDateCn, todayIso } from '@/app/date'
import { db, SCHEMA_VERSION } from '@/data/db'
import { countFoods } from '@/data/repositories/foods'
import { countOpenOps } from '@/data/repositories/pendingOps'
import { META_KEYS, getMeta } from '@/data/meta'

const router = useRouter()
const store = useDayStore()

const foodCount = ref(0)
const queueCount = ref(0)
const seedVersion = ref('-')
const retrying = ref(false)

onMounted(async () => {
  await store.load(todayIso())
  foodCount.value = await countFoods()
  queueCount.value = await countOpenOps()
  seedVersion.value = (await getMeta<string>(META_KEYS.seedVersion)) ?? '-'
})

const weightText = computed(() =>
  store.day?.weightAmKg === undefined ? '未称' : `${fmtNumber(store.day.weightAmKg)} kg`
)

const trainingText = computed(() => {
  if (store.summary.training.isRestDay) return '休息日'
  return `${fmtNumber(store.summary.training.minutes)} 分钟 · ${store.summary.training.sets} 组`
})

/** 进度条填充比例：上限类按 100% 截断，避免超出时条子溢出。 */
function fillPercent(ratio: number): number {
  return Math.max(0, Math.min(100, ratio * 100))
}

function isOver(row: { key: string; ratio: number }): boolean {
  return row.key === 'sodiumMg' ? row.ratio > 1 : row.ratio > 1.1
}

/** 今日进度里只放最常看的三项：热量、蛋白、钠。 */
const progressRows = computed(() =>
  store.summaryRows.filter((row) => ['kcal', 'proteinG', 'sodiumMg'].includes(row.key))
)

/** 手动重试待补全队列：平时它在启动 / 联网时自动跑，这里是兜底入口（§6.10）。 */
async function retryQueue(): Promise<void> {
  retrying.value = true
  try {
    const report = await runQueue()
    queueCount.value = await countOpenOps()
    const message =
      report.messages[report.messages.length - 1] ??
      report.skipped[0] ??
      (report.done ? '队列已处理' : '队列里没有可自动处理的项目')
    showToast({ message, position: 'bottom' })
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <section class="page">
    <AppHeader title="薄肌计划" :subtitle="`${formatDateCn(store.date)} · 数据全部保存在本机`" />

    <div class="card">
      <div class="card-head">
        <h2 class="card-title">今日进度</h2>
        <span v-if="store.summary.incomplete" class="tag">不完整</span>
      </div>

      <template v-if="store.hasTargets">
        <div v-for="row in progressRows" :key="row.key" class="progress-row">
          <div class="progress-head">
            <span>{{ row.label }}</span>
            <span class="progress-numbers">
              {{ fmtNumber(row.intake) }}
              <template v-if="row.target">
                / {{ row.key === 'sodiumMg' ? '≤' : '' }}{{ fmtNumber(row.target) }}
                <span class="progress-pct" :class="{ 'over': isOver(row) }">
                  {{ fmtPercent(row.ratio) }}
                </span>
              </template>
              <template v-else>/ -</template>
            </span>
          </div>
          <div class="progress">
            <div
              class="progress-fill"
              :class="{ over: isOver(row) }"
              :style="{ width: `${fillPercent(row.ratio)}%` }"
            />
          </div>
        </div>
      </template>

      <p v-else class="muted">
        还没有目标值：热量与蛋白只能显示摄入量，算不出占比。先去「目标」页做一次首次校准。
      </p>

      <div class="stat-row" style="margin-top: 12px">
        <div class="stat">
          <span class="stat-label">晨重</span>
          <span class="stat-value">{{ weightText }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">训练</span>
          <span class="stat-value">{{ trainingText }}</span>
        </div>
      </div>

      <p v-if="store.summary.incomplete" class="muted" style="margin-top: 8px">
        有 {{ store.pendingCount }} 条记录还没拿到营养数值，配好模型联网后会自动补齐。
      </p>
    </div>

    <div class="entry-grid">
      <van-button type="primary" block @click="router.push('/log/diet')">记饮食</van-button>
      <van-button plain type="primary" block @click="router.push('/log/workout')">记训练</van-button>
      <van-button plain type="primary" block @click="router.push('/log/body')">记身体</van-button>
      <van-button plain type="primary" block @click="router.push('/log/quick')">一句话记录</van-button>
    </div>

    <div v-if="store.summary.hints.length" class="card">
      <h2 class="card-title">今天要注意</h2>
      <ul class="hint-list">
        <li v-for="hint in store.summary.hints" :key="hint">{{ hint }}</li>
      </ul>
    </div>

    <div v-if="queueCount" class="card card-warn">
      <h2 class="card-title">待补全队列（{{ queueCount }}）</h2>
      <p class="muted">
        这些记录当时没拿到营养数值（未配模型或离线），配好模型后会自动补全并回算。
      </p>
      <div class="link-grid">
        <van-button size="small" type="primary" plain :loading="retrying" @click="retryQueue">
          立即重试
        </van-button>
        <van-button size="small" plain @click="router.push('/settings/model')">模型设置</van-button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">更多</h2>
      <div class="link-grid">
        <van-button size="small" plain block @click="router.push('/summary')">当日汇总</van-button>
        <van-button size="small" plain block @click="router.push('/trend')">趋势</van-button>
        <van-button size="small" plain block @click="router.push('/targets')">目标与校准</van-button>
        <van-button size="small" plain block @click="router.push('/profile')">档案</van-button>
        <van-button size="small" plain block @click="router.push('/settings/model')">模型设置</van-button>
        <van-button size="small" plain block @click="router.push('/foods')">食物库</van-button>
        <van-button size="small" plain block @click="router.push('/data')">数据</van-button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">本地数据</h2>
      <div class="kv">
        <span class="kv-key">数据库 schema</span>
        <span class="kv-value">v{{ db.verno }} / 目标 v{{ SCHEMA_VERSION }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">食物库条目</span>
        <span class="kv-value">{{ foodCount }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">种子库版本</span>
        <span class="kv-value">{{ seedVersion }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">待办队列</span>
        <span class="kv-value">{{ queueCount }}</span>
      </div>
    </div>

  </section>
</template>

<style scoped>
.progress-pct {
  margin-left: 6px;
  color: var(--brand);
}

.progress-pct.over {
  color: var(--danger);
}
</style>
