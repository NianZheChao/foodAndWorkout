// @vitest-environment jsdom
/**
 * 标签选择（单选 / 多选）。
 *
 * 选项一多（MET 15 项、肌群 9 项、器材 7 项）横排 checkbox 会挤成一团，这里换成
 * 会换行的按钮组；顺手把「再点一次取消」这个多选习惯固定成行为。
 * 用例都套一个会回写 v-model 的外壳，跟真实用法一致。
 */

import { defineComponent, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ChipSelect from '@/components/ChipSelect.vue'

function mountChips(options: {
  initial: string | string[]
  candidates: string[]
  multiple?: boolean
  ariaLabel?: string
}) {
  const Host = defineComponent({
    components: { ChipSelect },
    setup() {
      const value = ref<string | string[]>(options.initial)
      return { value, candidates: options.candidates, multiple: options.multiple ?? false, ariaLabel: options.ariaLabel }
    },
    template: `<ChipSelect v-model="value" :options="candidates" :multiple="multiple" :aria-label="ariaLabel" />`
  })
  return mount(Host)
}

function chip(wrapper: ReturnType<typeof mountChips>, label: string) {
  const found = wrapper.findAll('.chip').find((item) => item.text() === label)
  if (!found) throw new Error(`找不到选项「${label}」`)
  return found
}

describe('标签选择', () => {
  it('单选：点未选中的项换成它，点已选中的项取消', async () => {
    const wrapper = mountChips({ initial: '慢跑', candidates: ['走路', '慢跑', '跑步'] })
    expect(chip(wrapper, '慢跑').classes()).toContain('chip-on')

    await chip(wrapper, '跑步').trigger('click')
    expect(chip(wrapper, '跑步').classes()).toContain('chip-on')
    expect(chip(wrapper, '慢跑').classes()).not.toContain('chip-on')

    await chip(wrapper, '跑步').trigger('click')
    expect(chip(wrapper, '跑步').classes()).not.toContain('chip-on')
  })

  it('多选：点一下加入，再点一下移除', async () => {
    const wrapper = mountChips({ initial: ['胸'], candidates: ['胸', '背', '腿'], multiple: true })
    expect(chip(wrapper, '胸').classes()).toContain('chip-on')
    expect(chip(wrapper, '背').classes()).not.toContain('chip-on')

    await chip(wrapper, '背').trigger('click')
    expect(chip(wrapper, '背').classes()).toContain('chip-on')
    expect(chip(wrapper, '胸').classes()).toContain('chip-on')

    await chip(wrapper, '胸').trigger('click')
    expect(chip(wrapper, '胸').classes()).not.toContain('chip-on')
    expect(chip(wrapper, '背').classes()).toContain('chip-on')
  })

  it('每个选项都是可读的按钮（role=button + aria-pressed）', () => {
    const wrapper = mountChips({
      initial: [],
      candidates: ['哑铃'],
      multiple: true,
      ariaLabel: '可用器材'
    })
    const button = chip(wrapper, '哑铃')
    expect(wrapper.find('[role="group"]').attributes('aria-label')).toBe('可用器材')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(button.attributes('type')).toBe('button')
  })
})
