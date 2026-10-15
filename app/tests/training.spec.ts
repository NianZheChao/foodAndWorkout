import { describe, expect, it } from 'vitest'
import {
  aggregateWorkouts,
  entrySetsAndLoad,
  metKcal,
  parseSetVolume,
  rankMoves,
  setVolumeLoad,
  splitMuscles,
  volumeLoadOf
} from '@/domain/training'

describe('组次重量解析', () => {
  it('认出 x / х / × 三种乘号', () => {
    expect(parseSetVolume('4x10x60')).toEqual({ sets: 4, reps: 10, weightKg: 60, volumeLoad: 2400 })
    expect(parseSetVolume('3х12х40')).toEqual({ sets: 3, reps: 12, weightKg: 40, volumeLoad: 1440 })
    expect(parseSetVolume('4×8×57.5')).toEqual({
      sets: 4,
      reps: 8,
      weightKg: 57.5,
      volumeLoad: 1840
    })
  })

  it('自重 / 徒手不给容量负荷', () => {
    expect(parseSetVolume('3x15x自重')).toEqual({ sets: 3, reps: 15 })
    expect(parseSetVolume('3x15x徒手')).toEqual({ sets: 3, reps: 15 })
  })

  it('格式不对返回 undefined（调用方按 1 组兜底）', () => {
    expect(parseSetVolume('10个')).toBeUndefined()
    expect(parseSetVolume('')).toBeUndefined()
    expect(parseSetVolume(undefined)).toBeUndefined()
  })
})

describe('容量负荷', () => {
  it('自重动作计 0 组容量但仍计入组数', () => {
    expect(setVolumeLoad({ reps: 20, bodyweight: true })).toBe(0)
    expect(setVolumeLoad({ reps: 10, weightKg: 0, bodyweight: false })).toBe(0)
    expect(setVolumeLoad({ reps: 10, weightKg: 60, bodyweight: false })).toBe(600)
    expect(volumeLoadOf([{ reps: 10, weightKg: 60, bodyweight: false }, { reps: 5, weightKg: 60, bodyweight: false }])).toBe(900)
  })

  it('没有组次结构时按 1 组计', () => {
    expect(entrySetsAndLoad({ id: '1', date: '2026-10-13', type: '力量', muscles: [], exercise: '?' })).toEqual({
      sets: 1,
      load: 0
    })
  })
})

describe('MET 消耗', () => {
  it('与记录里的估算一致：5 MET / 75 kg / 45 min ≈ 295 kcal', () => {
    expect(metKcal(5, 75, 45)).toBeCloseTo(295.31, 2)
  })
})

describe('区间聚合', () => {
  it('按肌群累计组数与容量，自重不计容量', () => {
    const aggregate = aggregateWorkouts([
      {
        id: 'a',
        date: '2026-10-09',
        type: '力量',
        minutes: 45,
        rpe: 7,
        muscles: ['二头'],
        exercise: '站姿哑铃弯举',
        sets: [{ reps: 5, weightKg: 3, bodyweight: false }],
        volumeRaw: '3x5x3kg',
        volumeLoad: 45
      },
      {
        id: 'b',
        date: '2026-10-09',
        type: '力量',
        rpe: 7,
        muscles: ['三头'],
        exercise: '俯身哑铃臂屈伸',
        sets: [{ reps: 12, bodyweight: true }],
        volumeRaw: '3x12x自重'
      }
    ])
    expect(aggregate.rows).toBe(2)
    expect(aggregate.minutes).toBe(45)
    expect(aggregate.rpe).toEqual([7, 7])
    expect(aggregate.sets).toBe(2)
    expect(aggregate.load).toBe(45)
    expect(aggregate.loadedSets).toBe(1)
    expect(aggregate.bodyweightSets).toBe(1)
    expect(aggregate.muscles).toEqual({ 二头: 1, 三头: 1 })
    expect(aggregate.muscleLoad).toEqual({ 二头: 45 })
    expect(aggregate.moves['站姿哑铃弯举'].volume).toBe('3x5x3kg')
  })

  it('动作按容量降序排列', () => {
    const aggregate = aggregateWorkouts([
      { id: 'a', date: 'd', type: '力量', muscles: [], exercise: '轻', volumeLoad: 10, volumeRaw: '1x1x10' },
      { id: 'b', date: 'd', type: '力量', muscles: [], exercise: '重', volumeLoad: 100, volumeRaw: '1x1x100' }
    ])
    expect(rankMoves(aggregate.moves).map(([name]) => name)).toEqual(['重', '轻'])
  })

  it('肌群分隔符与脚本一致', () => {
    expect(splitMuscles('二头、三头/肩＋背,腿')).toEqual(['二头', '三头', '肩', '背', '腿'])
    expect(splitMuscles('')).toEqual([])
  })
})

