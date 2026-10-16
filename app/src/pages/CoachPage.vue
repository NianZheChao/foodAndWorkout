<script setup lang="ts">
/**
 * 今日指导（T3.7 / §6.4.2，A 级指导）。
 *
 * 这一页要同时说清三件事：
 * 1. **要发什么**：生成前的「将要发送的内容」预览 + 睡眠 / 精力 / 酸痛三个单独开关（FR-1602）。
 *    指导是高频调用，所以预览不能只留在报告里；
 * 2. **依据是什么**：每条建议下面列出它引用的本地字段，命不中依据的条目根本不会出现在这里（NFR-13）；
 * 3. **能表态**：采纳 / 不采纳写进 `adviceLog`，成为下一轮 `history.advice`。
 *
 * 没配模型时不装死：下面那块「本地缺口提示」是纯本地算的，照常有用（§9.3）。
 */

import { computed, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import {
  buildCoachContext,
  generateAdvice,
  markAdviceAdopted,
  resolveShareRecovery,
  DEFAULT_SHARE_RECOVERY,
  type CoachContext,
  type ShareRecovery
} from '@/application/coach'
import { getAdviceByDate } from '@/data/repositories/adviceLog'
import { getModelConfig, isModelConfigured } from '@/data/repositories/modelConfig'
import { getSettings, saveSettings } from '@/data/repositories/settings'
import { estimateTokens } from '@/llm'
import { todayIso } from '@/app/date'
import { confirmOverBudget } from '@/app/budget'
import type { AdviceRecord } from '@/domain/types'

const today = todayIso()

const advice = ref<AdviceRecord>()
const context = ref<CoachContext>()
const share = ref<ShareRecovery>({ ...DEFAULT_SHARE_RECOVERY })
const configured = ref(false)
const loaded = ref(false)
const busy = ref(false)
const showPreview = ref(false)
const notice = ref('')

async function load(): Promise<void> {
  const settings = await getSettings()
  share.value = resolveShareRecovery(settings)
  configured.value = isModelConfigured(await getModelConfig())
  context.value = await buildCoachContext(today, { shareRecovery: share.value })
  advice.value = await getAdviceByDate(today)
  loaded.value = true
}

onMounted(load)

/** 数据变了（指纹不一致）才提示「可以刷新」：否则每次打开都劝人再花一次 token。 */
const stale = computed(
  () => !!advice.value && !!context.value && advice.value.fingerprint !== context.value.fingerprint
)
const flagged = computed(() => advice.value?.flaggedNumbers ?? [])
const droppedAdvice = computed(() => advice.value?.droppedAdvice ?? 0)
const payloadText = computed(() => (context.value ? JSON.stringify(context.value.input, null, 2) : ''))
const payloadTokens = computed(() => (payloadText.value ? estimateTokens(payloadText.value) : 0))
const pendingLabel = computed(() => {
  const today_ = context.value?.input.today
  if (!today_) return '-'
  if (today_.remainingKcal === undefined) return '没设目标，算不出还差多少'
  return `还差 ${today_.remainingKcal} kcal · 蛋白 ${today_.remainingProteinG ?? '-'} g`
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

async function generate(force: boolean): Promise<void> {
  busy.value = true
  notice.value = ''
  try {
    const outcome = await generateAdvice({ date: today, force }, { confirm: confirmOverBudget })
    if (outcome.ok) {
      advice.value = outcome.record
      context.value = await buildCoachContext(today, { shareRecovery: share.value })
      if (outcome.cached) {
        showToast({ message: '今天已经生成过，数据没变，直接用这一版', position: 'bottom' })
      }
      if (outcome.notices.length) notice.value = outcome.notices.join('；')
      return
    }
    const reason = outcome.failure?.message ?? '未知原因'
    notice.value = `这次没能生成 AI 指导（${reason}）。下面的本地缺口提示照常可用。`
    if (!configured.value) notice.value += '先去模型设置把接口填上。'
  } finally {
    busy.value = false
  }
}

/** 关掉某一项自报数据：立刻重算摘要（指纹也跟着变，刷新时会用新的输入）。 */
async function toggleShare(key: keyof ShareRecovery): Promise<void> {
  share.value = { ...share.value, [key]: !share.value[key] }
  await saveSettings({ shareRecovery: { ...share.value } })
  context.value = await buildCoachContext(today, { shareRecovery: share.value })
}

async function adopt(index: number, adopted: boolean): Promise<void> {
  const current = advice.value
  if (!current) return
  advice.value = (await markAdviceAdopted(current.id, index, adopted)) ?? current
}

const SHARE_LABELS: { key: keyof ShareRecovery; label: string }[] = [
  { key: 'sleep', label: '睡眠' },
  { key: 'energy', label: '精力' },
  { key: 'soreness', label: '酸痛' }
]
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader
      title="今日指导"
      subtitle="AI 只读本地摘要，指出问题与今天该做的事；不出食谱、不排训练"
      back
    />

    <div v-if="!loaded" class="card"><p class="muted">读取中…</p></div>

    <template v-else>
      <div class="card">
        <div class="card-head">
          <h2 class="card-title">将要发送的内容</h2>
          <van-button size="mini" plain @click="showPreview = !showPreview">
            {{ showPreview ? '收起' : '展开' }}
          </van-button>
        </div>
        <p class="card-note muted">
          只发送近 {{ context?.input.digest.period.days ?? 7 }} 天的汇总数字与今天的缺口，约
          {{ payloadTokens }} tokens；没有原始记录、没有备注原文。下面三项可以单独关掉。
        </p>
        <div class="share-row">
          <label
            v-for="item in SHARE_LABELS"
            :key="item.key"
            class="share-item"
          >
            <input type="checkbox" :checked="share[item.key]" @change="toggleShare(item.key)" />
            {{ item.label }}
          </label>
        </div>
        <pre v-if="showPreview" class="payload">{{ payloadText }}</pre>
      </div>

      <div v-if="notice" class="card card-warn">
        <p class="muted warn-text">{{ notice }}</p>
      </div>

      <div v-if="stale" class="card card-warn">
        <h2 class="card-title">今天的数据已经变了</h2>
        <p class="muted">下面这版是对更早的数据生成的。点「刷新指导」会按现在的数据重新问一次模型。</p>
      </div>

      <div v-if="!advice" class="card">
        <h2 class="card-title">今天还没有指导</h2>
        <p class="muted">
          AI 会读近 7 天的摘要，给出 1-3 条带依据的判断与今天的重点。
          <template v-if="!configured">还没有配置模型接口，先去「模型设置」填上。</template>
        </p>
        <div class="actions">
          <van-button type="primary" block :loading="busy" @click="generate(false)">生成今日指导</van-button>
          <van-button v-if="!configured" plain block @click="$router.push('/settings/model')">
            去模型设置
          </van-button>
        </div>
      </div>

      <template v-else>
        <div class="card">
          <div class="card-head">
            <h2 class="card-title">结论</h2>
            <span v-if="advice.flaggedNumbers?.length" class="tag">有 {{ advice.flaggedNumbers.length }} 处待核对</span>
          </div>
          <p class="coach-headline">
            <template v-for="(part, index) in segments(advice.content.headline)" :key="index">
              <span v-if="part.flagged" class="flagged">{{ part.text }}</span>
              <template v-else>{{ part.text }}</template>
            </template>
          </p>

          <ul class="hint-list">
            <li v-for="(item, index) in advice.content.advice" :key="index">
              <span class="tag">{{ item.kind === 'fact' ? '事实' : '推断' }}</span>
              <span>
                <template v-for="(part, partIndex) in segments(item.text)" :key="partIndex">
                  <span v-if="part.flagged" class="flagged">{{ part.text }}</span>
                  <template v-else>{{ part.text }}</template>
                </template>
              </span>
              <span class="basis">依据：{{ item.basis.join(' · ') }}</span>
              <span class="basis-actions">
                <van-button
                  size="mini"
                  :type="item.adopted === true ? 'primary' : 'default'"
                  @click="adopt(index, true)"
                >
                  采纳
                </van-button>
                <van-button
                  size="mini"
                  :type="item.adopted === false ? 'primary' : 'default'"
                  @click="adopt(index, false)"
                >
                  不采纳
                </van-button>
                <span v-if="item.adopted !== undefined" class="muted">
                  已{{ item.adopted ? '采纳' : '不采纳' }}（下轮会带上）
                </span>
              </span>
            </li>
          </ul>

          <template v-if="advice.content.focus.length">
            <h2 class="card-title">今天重点</h2>
            <ul class="hint-list">
              <li v-for="item in advice.content.focus" :key="item">{{ item }}</li>
            </ul>
          </template>

          <template v-if="advice.content.ask.length">
            <h2 class="card-title">还缺的信息</h2>
            <ul class="hint-list">
              <li v-for="item in advice.content.ask" :key="item">{{ item }}</li>
            </ul>
          </template>

          <p v-if="droppedAdvice" class="muted">
            有 {{ droppedAdvice }} 条建议在本地数字里找不到依据，已按 NFR-13 去掉（见下面的提示）。
          </p>
          <p class="muted">{{ advice.content.disclaimer }}</p>
          <p class="muted">
            模型：{{ advice.model ?? '-' }} · 契约版本 v{{ advice.taskVersion ?? '-' }} · 依据校验：本地
          </p>
        </div>

      </template>

      <!-- 本地缺口提示在任何情况下都在：它不花钱、不需要模型，是这一页的保底（§9.3） -->
      <div class="card">
        <h2 class="card-title">本地缺口提示（不需要模型）</h2>
        <ul v-if="context?.localHints.length" class="hint-list">
          <li v-for="hint in context.localHints" :key="hint">{{ hint }}</li>
        </ul>
        <p v-else class="muted">今天的热量、蛋白、钠与纤维都在目标范围内，没有要补的。</p>
        <div class="kv">
          <span class="kv-key">今天已记</span>
          <span class="kv-value">{{ context?.input.today.kcalSoFar ?? 0 }} kcal</span>
        </div>
        <div class="kv">
          <span class="kv-key">缺口</span>
          <span class="kv-value">{{ pendingLabel }}</span>
        </div>
      </div>

      <div v-if="advice" class="actions">
        <van-button type="primary" block :loading="busy" @click="generate(true)">
          {{ stale ? '刷新指导' : '重新生成（会再调用一次模型）' }}
        </van-button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.coach-headline {
  margin: 0 0 10px;
  font-size: 15px;
  line-height: 1.7;
}

.flagged {
  background: #fff3cd;
  border-bottom: 1px dashed var(--accent);
  padding: 0 2px;
}

.basis {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 12px;
}

/* 一条建议有多行（正文 + 依据 + 表态），拉开一点更好读 */
.hint-list li {
  margin-top: 6px;
}

.basis-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
}

.share-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.share-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}

.payload {
  margin: 10px 0 0;
  padding: 10px;
  max-height: 260px;
  overflow: auto;
  background: var(--brand-soft);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
