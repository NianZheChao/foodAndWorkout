// @vitest-environment node
/**
 * 每日指导的本地闸门（T3.7 / §6.4.2）。
 *
 * 守三件事：**没依据的建议不展示**（NFR-13）、**样本不足时不出调整目标类建议**（FR-707 / FR-708）、
 * **编造的数字被标出来**（与报告共用同一套守卫）。外加缓存指纹与历史建议整理这两件工程细节。
 */

import { describe, expect, it } from 'vitest'
import {
  applyBasisGate,
  applyCoachCoverageGate,
  buildCoachHistory,
  coachFingerprint,
  flagCoachNumbers,
  isTargetChangeAdvice,
  resolveBasisPath,
  validBasisPaths,
  type CoachSource
} from '@/domain/coach'
import type { AdviceRecord, CoachContent, CoachTodayGap, ReportDigest } from '@/domain/types'

function digest(patch: Partial<ReportDigest> = {}): ReportDigest {
  return {
    period: { type: 'weekly', label: '近 7 天', start: '2026-10-10', end: '2026-10-16', days: 7 },
    coverage: { daysWithIntake: 5, daysWithWeight: 4, ratio: 0.71 },
    intake: {
      avgKcal: 1890,
      target: 2200,
      avgProteinG: 96,
      proteinTargetG: 150,
      kcalHitDays: 2,
      proteinHitDays: 1,
      recordedDays: 5,
      avgSodiumMg: 2400,
      sodiumMaxMg: 2000,
      sodiumOverDays: 3,
      avgFiberG: 18,
      fiberTargetG: 30,
      fiberHitDays: 1
    },
    weight: {
      amSeries: [{ date: '2026-10-15', kg: 74.2 }],
      ma7: 74.4,
      changeKg: -0.4,
      changePctPerWeek: -0.3
    },
    training: {
      days: 2,
      minutes: 90,
      sets: 24,
      volumeLoadKg: 3200,
      byMuscle: [{ muscle: '背', sets: 12 }],
      targetDays: 3,
      targetSetsPerMuscle: 10,
      rpeAvg: 7.5,
      highRpeEntries: 1,
      burnKcal: 180
    },
    recovery: {
      sleepDays: 4,
      avgSleepHours: 6.4,
      shortSleepDays: 2,
      ratedDays: 3,
      lowEnergyDays: 1,
      highSorenessDays: 1
    },
    currentTargets: { kcalTarget: 2200, proteinTargetG: 150, lastCalibrated: '2026-10-01' },
    ...patch
  }
}

const today: CoachTodayGap = {
  kcalSoFar: 1120,
  proteinSoFarG: 68,
  remainingKcal: 1080,
  remainingProteinG: 82,
  pendingItems: 0,
  trainedToday: false,
  weightAmKg: 74.2
}

function source(patch: { digest?: ReportDigest; today?: CoachTodayGap } = {}): CoachSource {
  return { digest: patch.digest ?? digest(), today: patch.today ?? today }
}

function content(patch: Partial<CoachContent> = {}): CoachContent {
  return {
    headline: '蛋白连续偏低，今天先把它补上。',
    advice: [{ kind: 'fact', text: '近 7 天平均蛋白 96 g。', basis: ['intake.avgProteinG'] }],
    // 刻意不在固定文案里放数字：守卫会扫 focus，一个凭空出现的数就会被标出来
    focus: ['晚饭先把蛋白补上'],
    ask: ['今天还练不练？'],
    disclaimer: '仅供参考。',
    ...patch
  }
}

function adviceRecord(date: string, items: AdviceRecord['content']['advice']): AdviceRecord {
  return {
    id: `adv_${date}`,
    date,
    content: content({ advice: items }),
    fingerprint: 'x',
    createdAt: 0,
    updatedAt: 0
  }
}

describe('依据校验（NFR-13）', () => {
  it('摘要路径、当日缺口路径与数组下标都能读出来', () => {
    expect(resolveBasisPath(source(), 'intake.avgProteinG')).toEqual({ ok: true, value: 96 })
    expect(resolveBasisPath(source(), 'today.remainingProteinG')).toEqual({ ok: true, value: 82 })
    expect(resolveBasisPath(source(), 'weight.amSeries.0.kg')).toEqual({ ok: true, value: 74.2 })
  })

  it('字段名写错、穿不过去、值为空都算命不中（空值不是 0，不能当依据）', () => {
    expect(resolveBasisPath(source(), 'recovery.energyDays').ok).toBe(false)
    expect(resolveBasisPath(source(), 'today.remainingFatG').ok).toBe(false)
    expect(resolveBasisPath(source(), 'weight.amSeries.9.kg').ok).toBe(false)
    expect(resolveBasisPath(source(), '').ok).toBe(false)
    // tdee 样本不足时整块不写进摘要，写它的建议就没有依据
    expect(resolveBasisPath(source(), 'tdee.value').ok).toBe(false)
    const sparse = source({ today: { ...today, remainingKcal: undefined } })
    expect(resolveBasisPath(sparse, 'today.remainingKcal').ok).toBe(false)
  })

  it('validBasisPaths 只留命中的，顺便把路径修剪干净', () => {
    expect(validBasisPaths(source(), [' intake.avgProteinG ', 'recovery.energyDays'])).toEqual([
      'intake.avgProteinG'
    ])
  })

  it('没依据的建议整条不展示，并在提示里点名', () => {
    const outcome = applyBasisGate(
      content({
        advice: [
          { kind: 'fact', text: '蛋白没吃够。', basis: ['intake.avgProteinG'] },
          { kind: 'inference', text: '你最近恢复不好。', basis: ['recovery.energyDays'] }
        ]
      }),
      source()
    )

    expect(outcome.content.advice.map((item) => item.text)).toEqual(['蛋白没吃够。'])
    expect(outcome.dropped).toEqual(['你最近恢复不好。'])
    expect(outcome.notices.join()).toContain('找不到依据')
    expect(outcome.notices.join()).toContain('你最近恢复不好。')
  })
})

describe('样本门禁（FR-707 / FR-708）', () => {
  it('覆盖率过半时不动', () => {
    const outcome = applyCoachCoverageGate(content(), digest())
    expect(outcome.content.headline).toBe('蛋白连续偏低，今天先把它补上。')
    expect(outcome.notices).toEqual([])
  })

  it('覆盖率不足时标题加「样本不足」，并去掉调整目标类建议', () => {
    const low = digest({ coverage: { daysWithIntake: 2, daysWithWeight: 1, ratio: 0.29 } })
    const outcome = applyCoachCoverageGate(
      content({
        advice: [
          { kind: 'fact', text: '近 7 天平均蛋白 96 g。', basis: ['intake.avgProteinG'] },
          { kind: 'inference', text: '热量目标可以下调。', basis: ['currentTargets.kcalTarget'] },
          { kind: 'inference', text: '实测 TDEE 偏低。', basis: ['tdee.value'] }
        ]
      }),
      low
    )

    expect(outcome.content.headline.startsWith('样本不足：')).toBe(true)
    expect(outcome.content.advice.map((item) => item.text)).toEqual(['近 7 天平均蛋白 96 g。'])
    expect(outcome.dropped).toEqual(['热量目标可以下调。', '实测 TDEE 偏低。'])
    expect(outcome.notices.join()).toContain('样本不足')
  })

  it('「调整目标」只认当前目标 / TDEE 这类依据', () => {
    expect(isTargetChangeAdvice({ kind: 'fact', text: 'x', basis: ['currentTargets.kcalTarget'] })).toBe(true)
    expect(isTargetChangeAdvice({ kind: 'fact', text: 'x', basis: ['tdee.value'] })).toBe(true)
    expect(isTargetChangeAdvice({ kind: 'fact', text: 'x', basis: ['intake.avgKcal'] })).toBe(false)
  })
})

describe('数字守卫（与报告同一套）', () => {
  it('白名单含当日缺口：说「还差 1080 kcal」不算编造', () => {
    expect(
      flagCoachNumbers(content({ headline: '今天还差 1080 kcal，先把蛋白补上。' }), source())
    ).toEqual([])
  })

  it('编出来的数字被标出来', () => {
    expect(
      flagCoachNumbers(
        content({
          headline: '今天还能吃 1080 kcal。',
          advice: [{ kind: 'inference', text: '照这样 6 周能到 78 kg。', basis: ['intake.avgKcal'] }]
        }),
        source()
      )
    ).toEqual(['78'])
  })
})

describe('缓存指纹（§6.4.2 频率与缓存）', () => {
  it('键序不同但数据相同 → 指纹相同', () => {
    const a = coachFingerprint({ digest: digest(), today })
    const b = coachFingerprint({ today: { ...today }, digest: digest() })
    expect(a).toBe(b)
  })

  it('数据变了 → 指纹变（否则会拿旧指导糊弄用户）', () => {
    const before = coachFingerprint(source())
    const after = coachFingerprint(source({ today: { ...today, kcalSoFar: 1400, remainingKcal: 800 } }))
    expect(after).not.toBe(before)
  })
})

describe('历史建议整理（history.advice）', () => {
  it('只带表过态的、同一句只留最近一次、按时间升序', () => {
    const records: AdviceRecord[] = [
      adviceRecord('2026-10-15', [
        { kind: 'fact', text: '把蛋白补到 150 g。', basis: ['intake.avgProteinG'], adopted: false },
        { kind: 'fact', text: '没表态的建议。', basis: ['intake.avgKcal'] }
      ]),
      adviceRecord('2026-10-16', [
        { kind: 'fact', text: '把蛋白补到 150 g。', basis: ['intake.avgProteinG'], adopted: true },
        { kind: 'fact', text: '今晚早点睡。', basis: ['recovery.sleepDays'], adopted: true }
      ])
    ]

    expect(buildCoachHistory(records)).toEqual([
      { date: '2026-10-16', text: '今晚早点睡。', adopted: true },
      { date: '2026-10-16', text: '把蛋白补到 150 g。', adopted: true }
    ])
  })
})
