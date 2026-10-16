<script setup lang="ts">
/**
 * 推荐清单（B 级，T3.8 / §6.5 / §6.6）：今天练什么 + 今天还能吃什么。
 *
 * 这一页的读法是「先看门禁，再看清单」：
 * 1. **开关默认关**：没开、或者档案里四项约束没齐，两个生成按钮都是禁用的（FR-1003）——
 *    按钮还留着（用户看得见这条路），原因与去处写在上面那张卡片里；
 * 2. **数值一律本地算**：动作的时长、食材的克数与四项合计、与缺口的差距都是本地的（FR-806）；
 *    模型的原文只出现在「将要发送的内容」预览里；
 * 3. **每一条都留了痕**：被剔除的动作、模型估值与本地库的偏差、加重超过 10% 都写在提示里。
 *
 * 生成要花钱，所以不会在进入页面时自动调用模型：要么点按钮，要么复用当天已生成的那一条。
 */

import { computed, onMounted, ref } from 'vue'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import {
  buildPlanContext,
  gateMessage,
  generateMealPlan,
  generateTrainingPlan,
  loadPlanRecords,
  type PlanContext
} from '@/application/plan'
import { getModelConfig, isModelConfigured } from '@/data/repositories/modelConfig'
import { compareWithGap, PREVIEW_TOLERANCE } from '@/domain/plan'
import { fmtNumber, fmtPercent } from '@/domain/format'
import { NUTRIENT_LABELS } from '@/domain/nutrition'
import { estimateTokens } from '@/llm'
import { todayIso } from '@/app/date'
import { confirmOverBudget } from '@/app/budget'
import type { MealPlanRecord, TrainingPlanRecord } from '@/domain/types'

const today = todayIso()

const context = ref<PlanContext>()
const training = ref<TrainingPlanRecord>()
const meal = ref<MealPlanRecord>()
const configured = ref(false)
const loaded = ref(false)
const busy = ref<'training' | 'meal'>()

async function load(): Promise<void> {
  context.value = await buildPlanContext(today)
  const records = await loadPlanRecords(today)
  training.value = records.training
  meal.value = records.meal
  configured.value = isModelConfigured(await getModelConfig())
  loaded.value = true
}

onMounted(load)

const blocked = computed(() => (context.value ? gateMessage(context.value.gate) : undefined))
const stale = computed(() => ({
  training: !!training.value && training.value.fingerprint !== context.value?.fingerprints.training,
  meal: !!meal.value && meal.value.fingerprint !== context.value?.fingerprints.meal
}))

const trainingPayload = computed(() =>
  context.value ? JSON.stringify(context.value.training, null, 2) : ''
)
const mealPayload = computed(() => (context.value ? JSON.stringify(context.value.meal, null, 2) : ''))
const trainingTokens = computed(() => (trainingPayload.value ? estimateTokens(trainingPayload.value) : 0))
const mealTokens = computed(() => (mealPayload.value ? estimateTokens(mealPayload.value) : 0))
const showTrainingPayload = ref(false)
const showMealPayload = ref(false)

/** 推荐吃了一顿之后离目标还差多少（本地减法，FR-802）。 */
const mealGapRows = computed(() =>
  context.value ? compareWithGap(meal.value?.content.totals ?? zeroTotals(), context.value.gap) : []
)
const mealTotals = computed(() => meal.value?.content.totals)

function zeroTotals() {
  return { kcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0, sodiumMg: 0 }
}

/** 主料 + 调味料合成一张表：调味料只多一个「调味」标记。 */
const mealLines = computed(() => {
  const content = meal.value?.content
  if (!content) return []
  return [...content.items, ...content.seasonings]
})

async function run(kind: 'training' | 'meal', force: boolean): Promise<void> {
  busy.value = kind
  try {
    const options = { confirm: confirmOverBudget }
    const outcome =
      kind === 'training'
        ? await generateTrainingPlan({ date: today, force }, options)
        : await generateMealPlan({ date: today, force }, options)
    if (outcome.ok) {
      if (kind === 'training') training.value = outcome.record as TrainingPlanRecord
      else meal.value = outcome.record as MealPlanRecord
      if (outcome.cached) {
        showToast({ message: '今天已经生成过，输入没变，直接用这一版', position: 'bottom' })
      } else if (outcome.notices.length) {
        showToast({ message: outcome.notices[0], position: 'bottom' })
      }
      return
    }
    if (outcome.blocked) {
      showToast({ message: outcome.blocked, position: 'bottom' })
      return
    }
    const reason = outcome.failure?.message ?? '未知原因'
    showToast({ message: `这次没能生成推荐（${reason}）`, position: 'bottom' })
  } finally {
    busy.value = undefined
  }
}

const GAP_LABELS = NUTRIENT_LABELS
/** 合计只显示这四项：钠与纤维进「与缺口对比」，不占合计的四个格子。 */
const MACRO_KEYS = ['kcal', 'proteinG', 'fatG', 'carbG'] as const
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader
      title="推荐清单"
      subtitle="B 级生成式推荐（默认关）：今天练什么 / 今天吃什么；数字一律按本地库与档案复算"
      back
    />

    <div v-if="!loaded" class="card"><p class="muted">读取中…</p></div>

    <template v-else>
      <div v-if="blocked" class="card card-warn">
        <h2 class="card-title">推荐现在是关着的</h2>
        <p class="muted warn-text">{{ blocked }}</p>
        <div class="actions">
          <van-button size="small" type="primary" plain block @click="$router.push('/settings')">
            去设置打开开关
          </van-button>
          <van-button
            v-if="context?.gate.missing.length"
            size="small"
            plain
            block
            @click="$router.push('/profile')"
          >
            去档案补约束
          </van-button>
        </div>
      </div>

      <div v-if="!configured" class="card">
        <p class="muted">
          还没有配置模型接口：推荐本身要调用模型才能生成。先去「模型设置」把地址 / token / 模型名填上。
        </p>
        <div class="actions">
          <van-button size="small" plain block @click="$router.push('/settings/model')">去模型设置</van-button>
        </div>
      </div>

      <!-- 今天练什么（FR-801） -->
      <div class="card">
        <div class="card-head">
          <h2 class="card-title">今天练什么</h2>
          <span class="tag">{{ training ? '已生成' : '未生成' }}</span>
        </div>

        <template v-if="training">
          <p class="plan-focus">{{ training.content.focus }}</p>
          <div class="kv">
            <span class="kv-key">预计时长（本地按组数估）</span>
            <span class="kv-value">{{ training.content.estimatedMinutes }} 分钟</span>
          </div>
          <div class="kv">
            <span class="kv-key">动作 / 总组数</span>
            <span class="kv-value">
              {{ training.content.exercises.length }} 个 · {{
                training.content.exercises.reduce((sum, item) => sum + item.sets, 0)
              }} 组
            </span>
          </div>

          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>动作</th>
                  <th>肌群</th>
                  <th class="num">组x次</th>
                  <th class="num">重量</th>
                  <th class="num">RPE</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(item, index) in training.content.exercises" :key="index">
                  <td>{{ item.name }}</td>
                  <td>{{ item.muscles.join('/') }}</td>
                  <td class="num">{{ item.sets }}x{{ item.reps }}</td>
                  <td class="num">{{ item.weightKg ? `${fmtNumber(item.weightKg)} kg` : '自重' }}</td>
                  <td class="num">{{ item.rpe ?? '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul class="hint-list">
            <li v-for="(item, index) in training.content.exercises" :key="`why-${index}`">
              <strong>{{ item.name }}</strong>：{{ item.reason }}
              <span v-if="item.progression" class="muted">（{{ item.progression }}）</span>
              <span v-if="item.weightNote" class="warn-text"> · {{ item.weightNote }}</span>
              <span v-else-if="item.equipmentNote" class="muted"> · {{ item.equipmentNote }}</span>
            </li>
          </ul>

          <ul v-if="training.content.notes.length" class="hint-list">
            <li v-for="note in training.content.notes" :key="note">{{ note }}</li>
          </ul>

          <ul v-if="training.notices?.length" class="hint-list warn-text">
            <li v-for="note in training.notices" :key="note">{{ note }}</li>
          </ul>

          <p class="muted">
            模型：{{ training.model ?? '-' }} · 契约版本 v{{ training.taskVersion ?? '-' }} ·
            器材与加重由本地复核，时长由本地按组数算
          </p>

          <div v-if="stale.training" class="card card-warn inner-card">
            <p class="muted">今天的数据已经变了，下面这版是对更早的数据生成的。</p>
          </div>
        </template>

        <p v-else class="muted">
          按「恢复优先 → 补欠账 → 渐进超负荷 → 器材约束 → 容量」排今天的动作，给一句话重点。
          输入只有本地摘要（缺口、近 14 天各肌群组数、上次同动作的写法）与档案里的约束。
        </p>

        <ul v-if="context?.training.needsRecovery.length" class="hint-list warn-text">
          <li>
            48 小时内练过、还没恢复：{{ context.training.needsRecovery.join(' / ') }}（恢复优先，FR-801）
          </li>
        </ul>

        <div class="card-head payload-head">
          <span class="muted">将要发送的内容：约 {{ trainingTokens }} tokens，没有原始记录</span>
          <van-button size="mini" plain @click="showTrainingPayload = !showTrainingPayload">
            {{ showTrainingPayload ? '收起' : '展开' }}
          </van-button>
        </div>
        <pre v-if="showTrainingPayload" class="payload">{{ trainingPayload }}</pre>

        <div class="actions">
          <van-button
            type="primary"
            block
            :disabled="!!blocked"
            :loading="busy === 'training'"
            @click="run('training', !!training)"
          >
            {{ training ? '重新生成（会再调用一次模型）' : '生成今天的训练' }}
          </van-button>
        </div>
      </div>

      <!-- 今天吃什么（FR-802） -->
      <div class="card">
        <div class="card-head">
          <h2 class="card-title">今天还能吃什么</h2>
          <span class="tag">{{ meal ? '已生成' : '未生成' }}</span>
        </div>

        <template v-if="meal">
          <p class="plan-focus">{{ meal.content.title }}</p>

          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>食材</th>
                  <th class="num">克数</th>
                  <th>做法</th>
                  <th class="num">热量</th>
                  <th class="num">蛋白</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, index) in mealLines" :key="index">
                  <td>
                    {{ line.food }}
                    <span v-if="line.seasoning" class="tag">调味</span>
                  </td>
                  <td class="num">{{ fmtNumber(line.grams) }} g</td>
                  <td>{{ line.dish || '-' }}</td>
                  <td class="num">
                    <template v-if="line.facts">{{ fmtNumber(line.facts.kcal) }}</template>
                    <span v-else class="warn-text">本地库里没有</span>
                  </td>
                  <td class="num">{{ line.facts ? fmtNumber(line.facts.proteinG) : '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 class="plan-subtitle">四项合计（本地按食物库重算）</h3>
          <div class="stat-row">
            <div v-for="key in MACRO_KEYS" :key="key" class="stat">
              <span class="stat-label">{{ GAP_LABELS[key] }}</span>
              <span class="stat-value">{{ fmtNumber(mealTotals?.[key]) }}</span>
            </div>
          </div>

          <template v-if="mealGapRows.length">
            <h3 class="plan-subtitle">与今天的缺口对比</h3>
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th class="num">这一顿</th>
                    <th class="num">还差</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in mealGapRows" :key="row.key">
                    <td>{{ GAP_LABELS[row.key] }}</td>
                    <td class="num">{{ fmtNumber(row.plan) }}</td>
                    <td class="num" :class="{ 'warn-text': row.over }">
                      {{ fmtNumber(row.remaining) }}
                      <span v-if="row.over">（超了）</span>
                      <span v-else-if="row.reached">（够）</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>

          <template v-if="meal.content.shoppingList?.length">
            <h3 class="plan-subtitle">采购清单</h3>
            <ul class="hint-list">
              <li v-for="item in meal.content.shoppingList" :key="item.item">
                {{ item.item }} · {{ item.amount }}
                <span v-if="item.substitute" class="muted">（不买也行：{{ item.substitute }}）</span>
              </li>
            </ul>
          </template>

          <ul v-if="meal.notices?.length" class="hint-list warn-text">
            <li v-for="note in meal.notices" :key="note">{{ note }}</li>
          </ul>

          <p class="muted">
            模型：{{ meal.model ?? '-' }} · 契约版本 v{{ meal.taskVersion ?? '-' }} ·
            合计与缺口对比由本地算（偏差阈值 {{ fmtPercent(PREVIEW_TOLERANCE) }}）
          </p>

          <div v-if="stale.meal" class="card card-warn inner-card">
            <p class="muted">今天的数据已经变了，下面这版是对更早的数据生成的。</p>
          </div>
        </template>

        <p v-else class="muted">
          先算今天的缺口（热量 / 蛋白 / 钠 / 纤维），再给 1-2 样主料的方案：逐食材列克数与做法，
          四项合计由本地按食物库重算。不问你「家里还有什么」（FR-803），也不改你的热量目标（FR-807）。
        </p>

        <div class="kv">
          <span class="kv-key">今天还差</span>
          <span class="kv-value">
            {{ context?.gap.remainingKcal === undefined ? '没设目标，算不出还差多少' : `${context?.gap.remainingKcal} kcal` }}
            · 蛋白 {{ context?.gap.remainingProteinG ?? '-' }} g
          </span>
        </div>

        <ul v-if="context?.localHints.length" class="hint-list">
          <li v-for="hint in context.localHints" :key="hint">{{ hint }}</li>
        </ul>

        <div class="card-head payload-head">
          <span class="muted">将要发送的内容：约 {{ mealTokens }} tokens，只给常用食材的名称</span>
          <van-button size="mini" plain @click="showMealPayload = !showMealPayload">
            {{ showMealPayload ? '收起' : '展开' }}
          </van-button>
        </div>
        <pre v-if="showMealPayload" class="payload">{{ mealPayload }}</pre>

        <div class="actions">
          <van-button
            type="primary"
            block
            :disabled="!!blocked"
            :loading="busy === 'meal'"
            @click="run('meal', !!meal)"
          >
            {{ meal ? '重新生成（会再调用一次模型）' : '生成今天还能吃什么' }}
          </van-button>
        </div>
      </div>

      <p class="muted">
        推荐只排今天的清单；热量目标只由报告与校准流程修改（FR-807）。清单是方案不是医嘱，
        照着做之前先看上面的本地提示。
      </p>
    </template>
  </section>
</template>

<style scoped>
.plan-focus {
  margin: 0 0 10px;
  font-size: 15px;
  line-height: 1.7;
}

.plan-subtitle {
  margin: 14px 0 6px;
  font-size: 14px;
}

.payload-head {
  margin-top: 12px;
}

.payload {
  margin: 8px 0 0;
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

/* 卡片里再嵌一张警示卡：去掉外边距与底色重叠，读起来才不像两张并列的卡片 */
.inner-card {
  margin-top: 10px;
  background: transparent;
  border: none;
  padding: 0;
}
</style>