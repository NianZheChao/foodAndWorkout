// @vitest-environment node
/**
 * 数字守卫与两道门禁（T3.2 / §6.4 / DR-37 / FR-904 / FR-708）。
 *
 * 守的是同一件事：**模型可以写结论，不能编数字**。编出来的数字不删改、只标「待核对」；
 * 超幅度的校准建议降级成待确认；样本不足时不给校准建议。
 */

import { describe, expect, it } from 'vitest'
import {
  applyCalibrationGate,
  applyCoverageGate,
  buildNumberWhitelist,
  flagUnknownNumbers,
  MAX_CALIBRATION_DELTA_KCAL
} from '@/domain/reportGuard'
import type { ReportContent, ReportDigest } from '@/domain/types'

function content(patch: Partial<ReportContent> = {}): ReportContent {
  return {
    summary: '本期一句话。',
    training: { assessment: '未达标', notes: [] },
    diet: { assessment: '基本达标', notes: [] },
    recovery: { notes: [] },
    findings: [],
    issues: [],
    actions: [],
    calibration: { recommended: false, deltaKcal: 0, rationale: '' },
    disclaimer: '仅供参考。',
    ...patch
  }
}

const digest: ReportDigest = {
  period: { type: 'weekly', label: '2026-W41', start: '2026-10-09', end: '2026-10-15', days: 7 },
  coverage: { daysWithIntake: 4, daysWithWeight: 3, ratio: 0.57 },
  intake: {
    avgKcal: 1893.6,
    target: 2240,
    avgProteinG: 88.7,
    proteinTargetG: 150,
    kcalHitDays: 0,
    proteinHitDays: 0,
    recordedDays: 4
  },
  weight: { amSeries: [{ date: '2026-10-13', kg: 75.1 }], ma7: 75.4, changeKg: -0.5, changePctPerWeek: -2.3 },
  training: {
    days: 1,
    minutes: 45,
    sets: 12,
    volumeLoadKg: 180,
    byMuscle: [{ muscle: '二头', sets: 6 }],
    targetDays: 3,
    targetSetsPerMuscle: 10
  },
  currentTargets: { kcalTarget: 2240, proteinTargetG: 150, lastCalibrated: '2026-10-10' }
}

describe('数字白名单', () => {
  it('摘要里出现的数字（含四舍五入形态与日期片段）都进白名单', () => {
    const whitelist = buildNumberWhitelist(digest)
    // 周期标签 `2026-W41` 与日期按数字片段收进来：模型引用时写的还是数字本身
    for (const value of ['1893.6', '1894', '2240', '7', '2026', '41', '75.4', '75', '180', '3', '10']) {
      expect(whitelist.has(value), `白名单缺少 ${value}`).toBe(true)
    }
  })
})

describe('标记待核对数字', () => {
  it('正文引用了摘要里的数：不标记', () => {
    const flagged = flagUnknownNumbers(
      content({
        summary: '本期日均摄入 1893.6 kcal，离 2240 kcal 的目标还差一截。',
        actions: ['把蛋白质补到 150 g']
      }),
      digest
    )
    expect(flagged).toEqual([])
  })

  it('模型自己算出来的数（摘要里没有）：标成待核对', () => {
    const flagged = flagUnknownNumbers(
      content({
        summary: '本期平均每天多吃了 380 kcal。',
        findings: [{ kind: 'inference', text: '按这个速度 6 周能到 78 kg。' }]
      }),
      digest
    )
    expect(flagged).toContain('380')
    expect(flagged).toContain('78')
  })

  it('百分比与派生常量放行（天/周/组/步长）', () => {
    const flagged = flagUnknownNumbers(
      content({
        summary: '达标 4/7 天，蛋白质只到目标的 40%。',
        actions: ['每周练 3 次，每次 45 分钟'],
        recovery: { notes: ['睡眠建议 7 小时，TDEE 取 50 的整数倍'] }
      }),
      digest
    )
    expect(flagged).toEqual([])
  })

  it('小整数也照样标记：编造出来的 78 kg 不能因为「数值不大」被放过', () => {
    const flagged = flagUnknownNumbers(
      content({ findings: [{ kind: 'inference', text: '照这个速度 6 周后到 78 kg。' }] }),
      digest
    )
    expect(flagged).toContain('78')
  })

  it('同一串数字出现多次只报一次，顺序稳定', () => {
    const flagged = flagUnknownNumbers(
      content({ summary: '多吃 380 kcal。', issues: ['又是 380 kcal。'], actions: ['别再多 999 kcal'] }),
      digest
    )
    expect(flagged).toEqual(['380', '999'])
  })
})

describe('校准门禁', () => {
  it('幅度在 ±150 kcal 内放行', () => {
    const result = applyCalibrationGate(
      content({ calibration: { recommended: true, deltaKcal: -120, rationale: '实测 TDEE 偏高' } })
    )
    expect(result.content.calibration.recommended).toBe(true)
    expect(result.notice).toBeUndefined()
  })

  it('幅度超限降级为待确认并说明原因（FR-904）', () => {
    const result = applyCalibrationGate(
      content({ calibration: { recommended: true, deltaKcal: -300, rationale: '实测 TDEE 偏高' } })
    )
    expect(result.content.calibration).toEqual({ recommended: false, deltaKcal: 0, rationale: '实测 TDEE 偏高' })
    expect(result.notice).toContain(String(MAX_CALIBRATION_DELTA_KCAL))
    expect(result.notice).toContain('待确认')
  })
})

describe('覆盖率门禁', () => {
  const lowCoverage: ReportDigest = { ...digest, coverage: { ...digest.coverage, ratio: 0.29 } }

  it('样本不足时不给校准建议（FR-708）', () => {
    const result = applyCoverageGate(
      content({ calibration: { recommended: true, deltaKcal: -100, rationale: 'x' } }),
      lowCoverage
    )
    expect(result.content.calibration.recommended).toBe(false)
    expect(result.notice).toContain('样本不足')
  })

  it('覆盖率够时不动内容', () => {
    const original = content({ calibration: { recommended: true, deltaKcal: -100, rationale: 'x' } })
    const result = applyCoverageGate(original, digest)
    expect(result.content).toBe(original)
    expect(result.notice).toBeUndefined()
  })
})
