<script setup lang="ts">
/**
 * 今日（M0 / M5）：一眼看完今天的状态，并进入记录流程。
 *
 * 三块内容：进度（热量 / 蛋白 / 体重 / 训练）、记录入口、待办与提示。
 * 数字全部来自 `store` 的本地汇总；这里只负责排版，不做任何计算。
 *
 * 「当日汇总 / 今日指导 / 推荐清单」这几个同级页**不在这里给按钮**：以前末尾挂着一张
 * 「更多」卡片，什么入口都往里塞（连隔壁域的档案、食物库也在里面），于是页面又长又乱、
 * 还出现「今日指导只能靠一个按钮进」。现在页头按 `app/nav.ts` 自动渲染本域导航条，
 * 同级页都在那一行里；本机数据（schema / 种子版本 / 队列）挪到了「我的」页。
 */

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import { useDayStore } from '@/store/day'
import { runQueue } from '@/application/queue'
import { buildReminderState } from '@/application/reminders'
import { fmtNumber, fmtPercent } from '@/domain/format'
import { reminderHint, reminderTarget } from '@/domain/reminders'
import { formatDateCn, todayIso } from '@/app/date'
import { getAdviceByDate } from '@/data/repositories/adviceLog'
import { countOpenOps } from '@/data/repositories/pendingOps'
import type { AdviceRecord, ReminderSetting } from '@/domain/types'

const router = useRouter()
const store = useDayStore()

const queueCount = ref(0)
const retrying = ref(false)
/** 今天的 AI 指导（不在这里生成：生成要花钱，得用户点进 /coach 才会调用模型） */
const advice = ref<AdviceRecord>()
/** 今天还没完成的事项（应用内提醒，T4.5 / FR-1101）：判定全在 `application/reminders` 里 */
const reminders = ref<ReminderSetting[]>([])

onMounted(async () => {
  await store.load(todayIso())
  queueCount.value = await countOpenOps()
  advice.value = await getAdviceByDate(todayIso())
  reminders.value = (await buildReminderState(todayIso())).pending
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
        有 {{ store.pendingCount }} 条记录还没拿到营养数值，配好模型联网后会自动补齐；
        也可以去「记录 → 饮食」里手工补齐。
      </p>
    </div>

    <div v-if="reminders.length" class="card">
      <div class="card-head">
        <h2 class="card-title">今天还没记的</h2>
        <span class="tag">提醒</span>
      </div>
      <p class="muted">
        设了时间的那几项，应用打开着的时候会弹一条系统通知（要授权）；这里是不管有没有通知都能看到的清单。
      </p>
      <ul class="reminder-list">
        <li v-for="row in reminders" :key="row.id">
          <div class="reminder-line">
            <span class="reminder-name">{{ row.label }}</span>
            <span class="muted">{{ reminderHint(row.id) }}</span>
          </div>
          <van-button size="mini" type="primary" plain @click="router.push(reminderTarget(row.id))">
            去补
          </van-button>
        </li>
      </ul>
      <div class="link-grid">
        <van-button size="small" plain @click="router.push('/settings')">提醒设置</van-button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2 class="card-title">今日指导</h2>
        <span class="tag">{{ advice ? '已生成' : '未生成' }}</span>
      </div>
      <template v-if="advice">
        <p class="coach-line">{{ advice.content.headline }}</p>
        <ul v-if="advice.content.focus.length" class="hint-list">
          <li v-for="item in advice.content.focus" :key="item">{{ item }}</li>
        </ul>
      </template>
      <p v-else class="muted">
        AI 读近 7 天的本地摘要，指出问题与今天该做的事（不出食谱、不排训练），每条建议都带本地依据。
      </p>
      <div class="link-grid">
        <van-button size="small" type="primary" plain @click="router.push('/coach')">
          {{ advice ? '看依据与反馈' : '生成今日指导' }}
        </van-button>
      </div>
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

  </section>
</template>

<style scoped>
.reminder-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.reminder-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.reminder-line {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.reminder-name {
  font-size: 15px;
  font-weight: 600;
}

.coach-line {
  margin: 0 0 8px;
  font-size: 15px;
  line-height: 1.7;
}

.progress-pct {
  margin-left: 6px;
  color: var(--brand);
}

.progress-pct.over {
  color: var(--danger);
}
</style>
