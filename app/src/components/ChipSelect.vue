<script setup lang="ts">
/**
 * 会把换行的「标签按钮」组，单选或多选都走它。
 *
 * 替代 Vant 的 radio / checkbox 横排：选项一多（MET 表 15 项、肌群 9 项）横排会挤成一团，
 * 手指也点不准（§8.4 要求触控目标 ≥ 44px）。这里用 flex-wrap，一个选项一个按钮。
 */

const props = withDefaults(
  defineProps<{
    modelValue: string | string[]
    options: readonly string[]
    multiple?: boolean
    ariaLabel?: string
  }>(),
  { multiple: false, ariaLabel: '选项' }
)

const emit = defineEmits<{ (event: 'update:modelValue', value: string | string[]): void }>()

function isSelected(option: string): boolean {
  return props.multiple ? (props.modelValue as string[]).includes(option) : props.modelValue === option
}

function toggle(option: string): void {
  if (!props.multiple) {
    emit('update:modelValue', props.modelValue === option ? '' : option)
    return
  }
  const next = [...(props.modelValue as string[])]
  const index = next.indexOf(option)
  if (index >= 0) next.splice(index, 1)
  else next.push(option)
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="chips" role="group" :aria-label="ariaLabel">
    <button
      v-for="option in options"
      :key="option"
      type="button"
      class="chip"
      :class="{ 'chip-on': isSelected(option) }"
      :aria-pressed="isSelected(option)"
      @click="toggle(option)"
    >
      {{ option }}
    </button>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  min-height: 34px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  cursor: pointer;
}

.chip:active {
  background: var(--brand-soft);
}

.chip-on {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-weight: 600;
}
</style>
