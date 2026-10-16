<script setup lang="ts">
/**
 * 一句话 / 拍照记录（FR-110 / FR-111 / FR-113），对应设计文档 §6.11 与 §6.12。
 *
 * 输入可以是任意说法（「中午西红柿鸡蛋拌面，4个西红柿 5个鸡蛋 80g 干面条，油盐正常量」），
 * 也可以是「照片 + 一句话」。解析结果一律先是**草稿**：估不准的进澄清卡片逐条问，
 * 回答完（或明确说「不记」）再落库；草稿期间不参与当日汇总（DR-48）。
 */

import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import AppHeader from '@/components/AppHeader.vue'
import { useDayStore } from '@/store/day'
import { useDraftStore, type DraftIntakeRow, type DraftWorkoutRow } from '@/store/draft'
import { compressImageFile } from '@/app/image'
import { todayIso } from '@/app/date'
import { confirmOverBudget } from '@/app/budget'
import { IMAGE_TOKEN_ESTIMATE } from '@/llm'
import { fmtNumber } from '@/domain/format'
import type { DraftKind, Meal } from '@/domain/types'

const MEALS: Meal[] = ['早餐', '午餐', '晚餐', '加餐']
const MAX_IMAGES = 3

const route = useRoute()
const router = useRouter()
const day = useDayStore()
const draft = useDraftStore()

const kind = ref<DraftKind>('intake')
const meal = ref<Meal>('午餐')
const text = ref('')
const images = ref<string[]>([])
const customAnswers = ref<Record<string, string>>({})
const intakeRows = ref<DraftIntakeRow[]>([])
const workoutRows = ref<DraftWorkoutRow[]>([])

const estimatedImageTokens = computed(() => images.value.length * IMAGE_TOKEN_ESTIMATE)
const answered = computed(() =>
  draft.questions.filter((question) => (draft.answerFor(question.field) ?? '').trim() !== '')
)
const pendingCount = computed(
  () => intakeRows.value.filter((row) => row.blocked).length + workoutRows.value.filter((row) => row.blocked).length
)

async function refreshRows(): Promise<void> {
  intakeRows.value = await draft.resolvedIntake()
  workoutRows.value = draft.resolvedWorkout()
}

onMounted(async () => {
  const hint = route.query.kind
  if (hint === 'workout' || hint === 'intake') kind.value = hint
  await draft.loadOpen(todayIso())
  if (draft.draft) {
    text.value = draft.draft.rawText
    kind.value = draft.draft.kind
    meal.value = draft.draft.meal
  }
  await refreshRows()
})

async function onFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  for (const file of files) {
    if (images.value.length >= MAX_IMAGES) {
      showToast({ message: `一次最多 ${MAX_IMAGES} 张`, position: 'bottom' })
      break
    }
    try {
      images.value.push(await compressImageFile(file))
    } catch {
      showToast({ message: '这张图读不了，换一张试试', position: 'bottom' })
    }
  }
  input.value = ''
}

function removeImage(index: number): void {
  images.value.splice(index, 1)
}

async function parse(): Promise<void> {
  const status = await draft.submit(
    {
      date: todayIso(),
      text: text.value,
      kind: kind.value,
      meal: meal.value,
      images: [...images.value]
    },
    // 估算超预算时问一句（§6.9）；选「先不发」不算失败，原文与图都还留着，可以直接改短再试
    { confirm: confirmOverBudget }
  )
  if (status !== 'failed') {
    // 图片只存在于内存，请求结束即释放（FR-1417）
    images.value = []
    customAnswers.value = {}
  }
  await refreshRows()
  if (status === 'ok') showToast({ message: '解析完成，确认后再保存', position: 'bottom' })
  if (status === 'kind-mismatch') showToast({ message: '模型判断的种类和入口不一致，请选一个', position: 'bottom' })
}

function answer(field: string, value: string): void {
  draft.answer(field, value)
  void refreshRows()
}

function useCustom(field: string): void {
  const value = (customAnswers.value[field] ?? '').trim()
  if (!value) return
  answer(field, value)
  customAnswers.value[field] = ''
}

async function save(): Promise<void> {
  await draft.commit(day)
  await day.load(todayIso())
  await refreshRows()
  showToast({ message: '已写入今天的记录', position: 'bottom' })
}

async function drop(): Promise<void> {
  await draft.discard()
  intakeRows.value = []
  workoutRows.value = []
  text.value = ''
  images.value = []
  customAnswers.value = {}
}

/** 模型不支持图片时的出口：丢掉图片，用原文当文字再试一次（图片不落库，丢得掉）。 */
async function dropImagesAndRetry(): Promise<void> {
  images.value = []
  draft.reset()
  if (!text.value.trim()) {
    showToast({ message: '没有文字可解析，直接写一句吃了什么吧', position: 'bottom' })
    return
  }
  await parse()
}

async function adopt(next: DraftKind): Promise<void> {
  await draft.adoptKind(next)
  kind.value = next
  await refreshRows()
}
</script>

<template>
  <section class="page">
    <AppHeader
      title="一句话 / 拍照记录"
      subtitle="随便说，模型只负责拆条目；克重与热量由本地换算。"
      back
    />

    <div class="card">
      <h2 class="card-title">记什么</h2>
      <van-radio-group v-model="kind" direction="horizontal">
        <van-radio name="intake">饮食</van-radio>
        <van-radio name="workout">训练</van-radio>
      </van-radio-group>
      <van-radio-group v-if="kind === 'intake'" v-model="meal" direction="horizontal" class="meal-group">
        <van-radio v-for="item in MEALS" :key="item" :name="item">{{ item }}</van-radio>
      </van-radio-group>
    </div>

    <div class="card">
      <h2 class="card-title">说一句 / 传张图</h2>
      <van-field
        v-model="text"
        type="textarea"
        rows="3"
        autosize
        placeholder="例如：今天中午吃了一顿西红柿鸡蛋拌面，4个西红柿、5个鸡蛋、80g 干面条，油盐正常量"
      />

      <div class="image-bar">
        <label class="image-pick">
          <input type="file" accept="image/*" multiple hidden @change="onFiles" />
          <span class="tag">＋ 拍照 / 选图</span>
        </label>
        <span v-if="images.length" class="muted">已选 {{ images.length }} 张 · 约 {{ estimatedImageTokens }} tokens</span>
      </div>
      <div v-if="images.length" class="thumbs">
        <div v-for="(image, index) in images" :key="index" class="thumb">
          <img :src="image" alt="待解析的图片" />
          <button type="button" class="thumb-remove" @click="removeImage(index)">×</button>
        </div>
      </div>
      <p v-if="images.length" class="muted">图片会上传到你配置的模型服务；压缩后只存在于内存，不会存进本地数据库。</p>

      <van-button type="primary" block :loading="draft.busy" @click="parse">解析</van-button>
    </div>

    <div v-if="draft.mismatch" class="card card-warn">
      <h2 class="card-title">种类不一致</h2>
      <p class="muted">
        在「{{ draft.mismatch.expected === 'intake' ? '饮食' : '训练' }}」入口提交，但内容看着更像「{{
          draft.mismatch.actual === 'intake' ? '饮食' : '训练'
        }}」。按哪个记？（不会替你改）
      </p>
      <div class="actions">
        <van-button size="small" type="primary" @click="adopt('intake')">按饮食记</van-button>
        <van-button size="small" plain type="primary" @click="adopt('workout')">按训练记</van-button>
      </div>
    </div>

    <div v-if="draft.error" class="card card-warn">
      <h2 class="card-title">这次没解析成功</h2>
      <p class="muted">{{ draft.error }}</p>
      <p class="muted">原文已留在草稿里，可以直接重试，或者去「记录 → 饮食 / 训练」手工录入。</p>
      <template v-if="draft.errorKind === 'unsupported-image'">
        <p class="muted">
          这条路走不通有两个出口：<strong>改用文字描述</strong>（把食材与份量写清楚，效果通常不差），
          或者去「模型设置」换一个支持视觉的模型。
        </p>
        <div class="actions">
          <van-button size="small" type="primary" @click="dropImagesAndRetry">去掉图片，用文字重试</van-button>
          <van-button size="small" plain @click="router.push('/settings/model')">去模型设置</van-button>
        </div>
      </template>
      <van-button v-else size="small" plain type="primary" @click="parse">重试</van-button>
    </div>

    <div v-if="draft.notices.length" class="card">
      <h2 class="card-title">提示</h2>
      <ul class="hint-list">
        <li v-for="notice in draft.notices" :key="notice">{{ notice }}</li>
      </ul>
    </div>

    <template v-if="draft.hasDraft && draft.draft">
      <div v-if="draft.openQuestions.length" class="card card-warn">
        <h2 class="card-title">先确认这几项</h2>
        <p class="muted">估不准就问一句，别硬填一个数。答「记不清」也可以，会留空并标注。</p>
        <div v-for="question in draft.openQuestions" :key="question.field" class="question">
          <p class="question-text">
            {{ question.question }}
            <span v-if="question.blocking" class="tag">必填</span>
          </p>
          <div class="options">
            <van-button
              v-for="option in question.options"
              :key="option"
              size="small"
              plain
              type="primary"
              @click="answer(question.field, option)"
            >
              {{ option }}
            </van-button>
          </div>
          <div class="custom-answer">
            <van-field v-model="customAnswers[question.field]" placeholder="也可以直接写，如 80g / 熟重 80g / 3组 x 10次" />
            <van-button size="small" type="primary" @click="useCustom(question.field)">用这个</van-button>
          </div>
        </div>
      </div>

      <div v-if="answered.length" class="card">
        <h2 class="card-title">已回答</h2>
        <div v-for="question in answered" :key="question.field" class="kv">
          <span class="kv-key">{{ question.field }}</span>
          <span class="kv-value">
            {{ draft.answerFor(question.field) }}
            <van-button size="mini" plain @click="answer(question.field, '')">改</van-button>
          </span>
        </div>
      </div>

      <div v-if="draft.draft.kind === 'intake'" class="card">
        <h2 class="card-title">草稿 · 饮食（{{ draft.draft.meal }}）</h2>
        <p v-if="draft.draft.dish" class="muted">{{ draft.draft.dish }}</p>
        <div v-for="row in intakeRows" :key="row.key" class="row">
          <div class="row-head">
            <strong>{{ row.food }}</strong>
            <span class="muted">{{ row.amountText || '—' }}</span>
          </div>
          <div class="row-body">
            <span v-if="row.grams !== undefined">{{ fmtNumber(row.grams) }} g</span>
            <span v-else class="warn-text">克重待定</span>
            <span v-if="row.facts">≈ {{ fmtNumber(row.facts.kcal) }} kcal</span>
            <span v-if="row.blocked" class="tag">待补全</span>
          </div>
          <p v-if="row.reason" class="muted">{{ row.reason }}</p>
        </div>
      </div>

      <div v-else class="card">
        <h2 class="card-title">草稿 · 训练（{{ draft.draft.workout.type }}）</h2>
        <div class="kv">
          <span class="kv-key">时长</span>
          <span class="kv-value">{{ draft.draft.workout.minutes ?? '未填' }} 分钟</span>
        </div>
        <div v-for="row in workoutRows" :key="row.key" class="row">
          <div class="row-head">
            <strong>{{ row.exercise }}</strong>
            <span class="muted">{{ row.sets }} 组 x {{ row.reps ?? '?' }} 次</span>
          </div>
          <div class="row-body">
            <span>{{ row.weightKg === undefined ? '自重' : `${fmtNumber(row.weightKg)} kg` }}</span>
            <span>容量 {{ fmtNumber(row.load) }} kg</span>
            <span v-if="row.blocked" class="tag">待补全</span>
          </div>
        </div>
      </div>

      <div v-if="draft.draft.assumptions.length" class="card">
        <h2 class="card-title">估算假设</h2>
        <ul class="hint-list">
          <li v-for="item in draft.draft.assumptions" :key="item">{{ item }}</li>
        </ul>
      </div>

      <div class="card">
        <h2 class="card-title">保存</h2>
        <p v-if="pendingCount" class="warn-text">
          有 {{ pendingCount }} 条还缺数值：会先记下来标「待补全」，补齐后自动重算，不会卡住记录。
        </p>
        <div class="actions">
          <van-button type="primary" block :loading="draft.busy" @click="save">保存到今天的记录</van-button>
          <van-button plain block @click="drop">放弃草稿</van-button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.card-warn {
  border-color: var(--warn);
  background: #fffaf3;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meal-group {
  margin-top: 10px;
}

.image-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
}

.image-pick {
  cursor: pointer;
}

.thumbs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.thumb {
  position: relative;
  width: 72px;
  height: 72px;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.thumb-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: var(--danger);
  color: #fff;
  line-height: 1;
}

.question {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
  margin-top: 10px;
}

.question-text {
  margin: 0 0 8px;
  font-size: 14px;
}

.options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.custom-answer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.row {
  border-top: 1px dashed var(--border);
  padding: 8px 0;
}

.row:first-of-type {
  border-top: none;
}

.row-head {
  display: flex;
  justify-content: space-between;
  font-size: 14px;
}

.row-body {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  margin-top: 4px;
}

.warn-text {
  font-size: 13px;
}
</style>
