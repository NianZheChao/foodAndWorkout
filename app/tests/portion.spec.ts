import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PORTION_GRAMS,
  describePortion,
  parsePortionInput,
  parseQuantity,
  resolvePortion
} from '@/domain/portion'
import type { Food } from '@/domain/types'

function foodOf(partial: Partial<Food>): Pick<Food, 'unit' | 'basisGrams' | 'portions'> {
  return { unit: '100g', ...partial }
}

describe('份量文本解析', () => {
  it('识别质量与体积', () => {
    expect(parsePortionInput('100g')).toEqual({ qty: 100, unit: 'g' })
    expect(parsePortionInput('250ml')).toEqual({ qty: 250, unit: 'ml' })
    expect(parsePortionInput('80 克')).toEqual({ qty: 80, unit: '克' })
  })

  it('识别「数量 + 计量词」与括号里的克重', () => {
    expect(parsePortionInput('2只')).toEqual({ qty: 2, unit: '只' })
    expect(parsePortionInput('2只(100g)')).toEqual({ qty: 2, unit: '只', explicitGrams: 100 })
    expect(parsePortionInput('一碗(150g)')).toEqual({ qty: 1, unit: '碗', explicitGrams: 150 })
  })

  it('括号里没有数字时不算显式克重，但质量单位仍然生效', () => {
    expect(parsePortionInput('330g(整盒)')).toEqual({ qty: 330, unit: 'g', explicitGrams: undefined })
  })

  it('全角括号与空格会被归一化', () => {
    expect(parsePortionInput('2 只 （ 100 g ）')).toEqual({ qty: 2, unit: '只', explicitGrams: 100 })
  })

  it('中文数字与「半」可用', () => {
    expect(parseQuantity('半')).toBe(0.5)
    expect(parseQuantity('两')).toBe(2)
    expect(parseQuantity('十')).toBe(10)
    expect(parseQuantity('十五')).toBe(15)
    expect(parseQuantity('二十三')).toBe(23)
    expect(parseQuantity('甲')).toBeUndefined()
  })

  it('无法识别的文本返回 undefined', () => {
    expect(parsePortionInput('')).toBeUndefined()
    expect(parsePortionInput('一点点')).toBeUndefined()
  })
})

describe('份量折算', () => {
  it('显式克重与质量单位直接采用', () => {
    expect(resolvePortion('2只(100g)')).toMatchObject({ grams: 100, basis: 'explicit' })
    expect(resolvePortion('80g')).toMatchObject({ grams: 80, basis: 'mass' })
  })

  it('计量词与食物条目基准一致时按基准折算', () => {
    const food = foodOf({ unit: '个', basisGrams: 50 })
    expect(resolvePortion('2个', food)).toMatchObject({ grams: 100, basis: 'foodBasis' })
  })

  it('命中食物条目自带份量表时优先用份量表', () => {
    const food = foodOf({ unit: '100g', portions: [{ label: '1盒', grams: 250 }] })
    expect(resolvePortion('1盒', food)).toMatchObject({ grams: 250, basis: 'foodPortion' })
  })

  it('只能按常见值估算时标注为假设并要求确认', () => {
    const result = resolvePortion('一碗')
    expect(result.basis).toBe('assumed')
    expect(result.grams).toBe(DEFAULT_PORTION_GRAMS['碗'])
    expect(result.note).toContain('请确认')
  })

  it('无法折算时不给克数，并提示补充信息（DR-47 / DR-49）', () => {
    const result = resolvePortion('一把抓')
    expect(result.basis).toBe('unknown')
    expect(result.grams).toBeUndefined()
    expect(result.note).toBeTruthy()
  })

  it('解释性文本可读', () => {
    expect(describePortion(resolvePortion('2只(100g)'))).toBe('2只(100g)')
    expect(describePortion(resolvePortion('80g'))).toBe('80g')
    expect(describePortion(resolvePortion('一碗'))).toBe('1碗（约 150 g）')
  })
})

