<script setup lang="ts">
/**
 * 记身体面板（M3 / FR-300），由 LogHubPage 承载。路由与日期归 hub 管，这里只读 store。
 *
 * 晨重是趋势与 TDEE 的唯一基准；只称了一个就只填一个，不要拿睡前值去填晨重（DR-08）。
 */

import { computed, ref, watch } from 'vue'
import { showToast } from 'vant'
import { useDayStore } from '@/store/day'
import { isPlausibleWeight } from '@/domain/weight'
import { fmtNumber, fmtSigned } from '@/domain/format'

const store = useDayStore()

const weightAm = ref('')
const weightPm = ref('')
const sleepHours = ref('')
const energy = ref<number>()
const soreness = ref<number>()
const note = ref('')
const busy = ref(false)

watch(
  () => store.day,
  () => syncFromStore(),
  { immediate: true }
)

function syncFromStore(): void {
  const day = store.day
  weightAm.value = day?.weightAmKg === undefined ? '' : String(day.weightAmKg)
  weightPm.value = day?.weightPmKg === undefined ? '' : String(day.weightPmKg)
  sleepHours.value = day?.sleepHours === undefined ? '' : String(day.sleepHours)
  energy.value = day?.energy
  soreness.value = day?.soreness
  note.value = day?.note ?? ''
}

function parsed(value: string): number | undefined {
  const result = Number(value)
  return value.trim() === '' || !Number.isFinite(result) ? undefined : result
}

/** 预览：用当前表单里的晨重，而不是已保存的值，边填边看。 */
const overnight = computed(() => {
  const am = parsed(weightAm.value)
  if (!isPlausibleWeight(am) || !isPlausibleWeight(store.previousEveningKg)) return undefined
  return am - store.previousEveningKg
})

const warnings = computed(() => {
  const list: string[] = []
  const am = parsed(weightAm.value)
  const pm = parsed(weightPm.value)
  if (am !== undefined && !isPlausibleWeight(am)) list.push('晨重看起来不在 25–300 kg 之间，请确认')
  if (pm !== undefined && !isPlausibleWeight(pm)) list.push('睡前重看起来不在 25–300 kg 之间，请确认')
  if (am === undefined && pm !== undefined) list.push('只填了睡前重：它不会进入趋势与 TDEE，需要晨重')
  return list
})

async function save(): Promise<void> {
  busy.value = true
  try {
    await store.saveBody({
      weightAmKg: parsed(weightAm.value),
      weightPmKg: parsed(weightPm.value),
      sleepHours: parsed(sleepHours.value),
      energy: energy.value,
      soreness: soreness.value,
      note: note.value.trim() || undefined
    })
    showToast({ message: '已保存', position: 'bottom' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="panel">
    <div class="card">
      <van-field v-model="weightAm" label="晨重(kg)" type="number" placeholder="晨起空腹，留空表示没称" />
      <van-field v-model="weightPm" label="睡前(kg)" type="number" placeholder="可选，仅用于算夜间净流失" />
      <van-field v-model="sleepHours" label="睡眠(h)" type="number" placeholder="可选" />
      <van-field label="精力">
        <template #input>
          <van-rate v-model="energy" :count="5" />
        </template>
      </van-field>
      <van-field label="酸痛">
        <template #input>
          <van-rate v-model="soreness" :count="5" />
        </template>
      </van-field>
      <van-field v-model="note" label="备注" type="textarea" rows="2" autosize placeholder="可选" />

      <div v-if="overnight !== undefined" class="kv">
        <span class="kv-key">夜间净流失</span>
        <span class="kv-value">{{ fmtSigned(overnight) }} kg</span>
      </div>
      <p v-for="warning in warnings" :key="warning" class="warn-text">{{ warning }}</p>

      <van-button type="primary" block :loading="busy" style="margin-top: 12px" @click="save">
        保存
      </van-button>
    </div>

    <div class="card">
      <h2 class="card-title">最近晨重</h2>
      <div v-if="Object.keys(store.weightSeries).length" class="weight-list">
        <div v-for="(value, date) in store.weightSeries" :key="date" class="kv">
          <span class="kv-key">{{ date }}</span>
          <span class="kv-value">{{ fmtNumber(value) }} kg</span>
        </div>
      </div>
      <p v-else class="muted">还没有可用晨重。</p>
    </div>
  </div>
</template>

<style scoped>
.warn-text {
  color: var(--warn);
  font-size: 13px;
  margin: 6px 0 0;
}

.weight-list {
  max-height: 240px;
  overflow-y: auto;
}
</style>
