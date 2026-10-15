<script setup lang="ts">
/**
 * 记训练面板（M2 / FR-200），由 LogHubPage 承载。路由与日期归 hub 管，这里只读 store。
 *
 * 容量负荷（组×次×重量）与有氧消耗（MET × 3.5 × 体重 / 200 × 时长）全部本地计算；
 * 缺体重时不给消耗数字，而是提示补体重（DR-49）。
 */

import { computed, ref } from 'vue'
import { showToast } from 'vant'
import { useDayStore } from '@/store/day'
import { MET_TABLE, metKcal, volumeLoadOf } from '@/domain/training'
import { fmtNumber } from '@/domain/format'
import type { WorkoutSet, WorkoutType } from '@/domain/types'

const TYPES: WorkoutType[] = ['力量', '有氧', '球类', '拉伸', '其他']
const MUSCLE_OPTIONS = ['胸', '背', '肩', '二头', '三头', '腿', '臀', '核心', '全身']

const store = useDayStore()

const type = ref<WorkoutType>('力量')
const exercise = ref('')
const muscles = ref<string[]>([])
const minutes = ref('')
const rpe = ref('')
const reps = ref('')
const weightKg = ref('')
const setCount = ref('1')
const metName = ref('慢跑')
const busy = ref(false)

const isCardio = computed(() => type.value !== '力量')
const met = computed(() => MET_TABLE[metName.value] ?? MET_TABLE['慢跑'])

function parsed(value: string): number | undefined {
  const result = Number(value)
  return value.trim() === '' || !Number.isFinite(result) ? undefined : result
}

/** 一次填写的组次结构按「组数」展开成多条 set，容量负荷交给 domain 计算。 */
const draftSets = computed<WorkoutSet[]>(() => {
  const count = parsed(setCount.value) ?? 1
  const repsValue = parsed(reps.value)
  if (!repsValue || count < 1) return []
  const load = parsed(weightKg.value)
  return Array.from({ length: Math.min(count, 50) }, () => ({
    reps: repsValue,
    weightKg: load,
    bodyweight: load === undefined
  }))
})

const draftVolume = computed(() => volumeLoadOf(draftSets.value))

const draftBurn = computed(() => {
  const minutesValue = parsed(minutes.value)
  if (!isCardio.value || !minutesValue) return undefined
  const bodyWeight = store.bodyWeightForBurn
  if (!bodyWeight) return undefined
  return metKcal(met.value, bodyWeight.weightKg, minutesValue)
})

const canSubmit = computed(() => {
  if (!exercise.value.trim() && !isCardio.value) return false
  if (isCardio.value) return !!parsed(minutes.value)
  return draftSets.value.length > 0
})

const bodyWeightHint = computed(() => {
  const bodyWeight = store.bodyWeightForBurn
  if (bodyWeight) return `按 ${bodyWeight.from} 的 ${fmtNumber(bodyWeight.weightKg)} kg 估算`
  return '缺少体重，无法估算消耗；先记一次体重（或者只填时长，消耗留空）'
})

async function submit(): Promise<void> {
  busy.value = true
  try {
    await store.addWorkoutEntry({
      type: type.value,
      exercise: exercise.value.trim() || metName.value,
      muscles: muscles.value,
      minutes: parsed(minutes.value),
      rpe: parsed(rpe.value),
      sets: isCardio.value ? undefined : draftSets.value,
      volumeRaw: isCardio.value
        ? undefined
        : `${draftSets.value.length}x${draftSets.value[0].reps}x${weightKg.value.trim() || '自重'}`,
      volumeLoad: isCardio.value ? undefined : draftVolume.value,
      estimatedKcal: isCardio.value ? draftBurn.value : undefined
    })
    showToast({ message: '已记录', position: 'bottom' })
    exercise.value = ''
    reps.value = ''
    weightKg.value = ''
    setCount.value = '1'
    minutes.value = ''
    rpe.value = ''
  } catch (cause) {
    showToast({ message: `记录失败：${cause instanceof Error ? cause.message : cause}`, position: 'bottom' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="page">
    <div class="card">
      <van-field label="类型">
        <template #input>
          <van-radio-group v-model="type" direction="horizontal">
            <van-radio v-for="item in TYPES" :key="item" :name="item">{{ item }}</van-radio>
          </van-radio-group>
        </template>
      </van-field>

      <van-field
        v-model="exercise"
        :label="isCardio ? '项目' : '动作'"
        :placeholder="isCardio ? '如：跑步' : '如：哑铃卧推'"
      />

      <template v-if="isCardio">
        <van-field label="项目（MET）">
          <template #input>
            <van-radio-group v-model="metName" direction="horizontal">
              <van-radio v-for="(_, name) in MET_TABLE" :key="name" :name="String(name)">
                {{ name }}
              </van-radio>
            </van-radio-group>
          </template>
        </van-field>
        <van-field v-model="minutes" label="时长(min)" type="number" />
      </template>

      <template v-else>
        <van-field label="目标肌群">
          <template #input>
            <van-checkbox-group v-model="muscles" direction="horizontal">
              <van-checkbox v-for="item in MUSCLE_OPTIONS" :key="item" :name="item" shape="square">
                {{ item }}
              </van-checkbox>
            </van-checkbox-group>
          </template>
        </van-field>
        <van-field v-model="setCount" label="组数" type="number" placeholder="3" />
        <van-field v-model="reps" label="每组次数" type="number" placeholder="10" />
        <van-field v-model="weightKg" label="负重(kg)" type="number" placeholder="留空表示自重" />
      </template>

      <van-field v-model="rpe" label="RPE" type="number" placeholder="可选，如 7" />

      <div class="hint-box">
        <p v-if="isCardio" class="muted">{{ bodyWeightHint }}</p>
        <div class="facts-grid">
          <div v-if="!isCardio" class="facts-cell">
            <span class="facts-label">容量负荷</span>
            <span class="facts-value">{{ fmtNumber(draftVolume) }} kg</span>
          </div>
          <div v-if="isCardio" class="facts-cell">
            <span class="facts-label">估算消耗</span>
            <span class="facts-value">
              {{ draftBurn === undefined ? '-' : `${fmtNumber(draftBurn)} kcal` }}
            </span>
          </div>
          <div class="facts-cell">
            <span class="facts-label">动作组数</span>
            <span class="facts-value">{{ isCardio ? '-' : draftSets.length }}</span>
          </div>
        </div>
      </div>

      <van-button type="primary" block :disabled="!canSubmit" :loading="busy" @click="submit">
        加入今日训练
      </van-button>
    </div>

    <div class="card">
      <h2 class="card-title">今天已记录</h2>
      <div v-for="entry in store.workout" :key="entry.id" class="entry-row">
        <div>
          <div class="entry-name">
            {{ entry.exercise }}
            <span class="tag">{{ entry.type }}</span>
          </div>
          <div class="entry-meta">
            <template v-if="entry.sets?.length">
              {{ entry.sets.length }} 组 × {{ entry.sets[0].reps }} 次
              <template v-if="entry.sets[0].weightKg">× {{ fmtNumber(entry.sets[0].weightKg) }} kg</template>
              <template v-else>（自重）</template>
              · 容量 {{ fmtNumber(entry.volumeLoad ?? 0) }} kg
            </template>
            <template v-else-if="entry.minutes">{{ fmtNumber(entry.minutes) }} 分钟</template>
            <template v-if="entry.muscles.length"> · {{ entry.muscles.join('、') }}</template>
            <template v-if="entry.rpe"> · RPE {{ fmtNumber(entry.rpe) }}</template>
            <template v-if="entry.estimatedKcal"> · 消耗 {{ fmtNumber(entry.estimatedKcal) }} kcal</template>
          </div>
        </div>
        <van-button size="mini" plain type="danger" @click="store.removeWorkoutEntry(entry.id)">删除</van-button>
      </div>
      <p v-if="!store.workout.length" class="muted">今天还没有训练记录（休息日）。</p>
      <div v-if="store.training.rows" class="training-total">
        合计 {{ fmtNumber(store.training.minutes) }} 分钟 · {{ store.training.sets }} 组 ·
        容量 {{ fmtNumber(store.training.load) }} kg
      </div>
    </div>
  </section>
</template>

<style scoped>
.hint-box {
  padding: 8px 0;
}

.facts-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-top: 8px;
}

.facts-cell {
  display: flex;
  flex-direction: column;
  background: var(--brand-soft);
  border-radius: 8px;
  padding: 6px 8px;
}

.facts-label {
  color: var(--text-muted);
  font-size: 12px;
}

.facts-value {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.entry-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border);
}

.entry-name {
  font-size: 14px;
}

.entry-meta {
  color: var(--text-muted);
  font-size: 12px;
}

.training-total {
  margin-top: 10px;
  font-size: 13px;
  color: var(--brand);
}
</style>
