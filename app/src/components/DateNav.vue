<script setup lang="ts">
import { computed } from 'vue'
import { addDays, formatDateCn, todayIso } from '@/app/date'

const props = defineProps<{ date: string }>()
const emit = defineEmits<{ (event: 'update:date', value: string): void }>()

const today = todayIso()
const isToday = computed(() => props.date === today)
/** 不允许记录未来：脚本与口径都按「已发生的一天」处理。 */
const canForward = computed(() => props.date < today)

function shift(days: number): void {
  emit('update:date', addDays(props.date, days))
}
</script>

<template>
  <div class="date-nav">
    <van-button size="small" plain type="primary" @click="shift(-1)">前一天</van-button>
    <div class="date-nav-label">
      <strong>{{ formatDateCn(date) }}</strong>
      <span v-if="isToday" class="date-nav-today">今天</span>
    </div>
    <van-button size="small" plain type="primary" :disabled="!canForward" @click="shift(1)">
      后一天
    </van-button>
  </div>
</template>

<style scoped>
.date-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.date-nav-label {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 15px;
}

.date-nav-today {
  color: var(--brand);
  font-size: 12px;
}
</style>

