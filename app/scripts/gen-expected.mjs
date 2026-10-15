#!/usr/bin/env node
/**
 * 生成对拍期望值：调用 `scripts/nutrition.py`，把输出原样落到 `tests/fixtures/`。
 *
 * 脚本是验收基准（docs/pwa-design.md §5.3）。改了 `domain/` 的计算口径后，
 * 必须重跑本脚本再跑 `npm test`。
 *
 * **自包含**：期望值由 `tests/fixtures/` 里那批合成记录生成 ——
 * 本脚本把 `scripts/nutrition.py`、`data/foods.csv` 与 fixtures 组装成一个临时工作区再跑，
 * 因此仓库里不需要任何真实记录、档案或目标文件（2026-10-15 起本仓库只放 app）。
 *
 * 用法：npm run expected
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const REPO = resolve(APP, '..')
const SCRIPT = join(REPO, 'scripts', 'nutrition.py')
const FOODS_CSV = join(REPO, 'data', 'foods.csv')
const OUT_DIR = join(APP, 'tests', 'fixtures')
const FIXTURES = OUT_DIR

const CASES = [
  ['expected-totals.txt', ['totals', '2026-10-13']],
  ['expected-trend.txt', ['trend', '--days', '14']],
  ['expected-tdee.txt', ['tdee', '--days', '28']],
  ['expected-init.txt', ['init']]
]

const LAUNCHERS = process.platform === 'win32' ? [['python'], ['py', '-3']] : [['python3'], ['python']]

/** 探测可用的 Python 启动器；只在开头做一次，避免把「非零退出」误判成「启动器不可用」。 */
function resolveLauncher() {
  for (const launcher of LAUNCHERS) {
    try {
      execFileSync(launcher[0], [...launcher.slice(1), '--version'], { encoding: 'utf8' })
      return launcher
    } catch {
      // 换下一个候选
    }
  }
  throw new Error('找不到可用的 Python，请确认 python / py / python3 在 PATH 里')
}

const LAUNCHER = resolveLauncher()

/**
 * 把脚本与 fixtures 组装成一个临时工作区。
 *
 * `nutrition.py` 是按自身位置找 `records/` `targets.md` `profile.md` `data/foods.csv` 的，
 * 所以这里复制成同样的目录结构；跑完即删，不落进仓库。
 */
function buildTempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'thin-muscle-expected-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  copyFileSync(SCRIPT, join(root, 'scripts', 'nutrition.py'))
  copyFileSync(FOODS_CSV, join(root, 'data', 'foods.csv'))
  cpSync(join(FIXTURES, 'records'), join(root, 'records'), { recursive: true })
  copyFileSync(join(FIXTURES, 'profile.md'), join(root, 'profile.md'))
  copyFileSync(join(FIXTURES, 'targets.md'), join(root, 'targets.md'))
  return root
}

/**
 * 运行脚本并返回 stdout。
 *
 * 脚本会用非零退出码表达「数据不足」这类业务结论（如 `tdee` 样本不够），
 * 那种情况下 stdout 仍是有意义的期望值，必须一并保留。
 */
function runNutrition(args, cwd) {
  // 必须调用**临时工作区里那份**脚本：它按自身位置找 records / profile / targets，
  // 调用仓库里那份会让 __file__ 指回仓库根，又去读真实文件（2026-10-15 踩过）。
  const script = join(cwd, 'scripts', 'nutrition.py')
  try {
    return execFileSync(LAUNCHER[0], [...LAUNCHER.slice(1), script, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout) return error.stdout
    throw error
  }
}

/** 期望值只在「跑脚本时用的那个临时工作区」里产生，跑完就删。 */
const TEMP_WORKSPACE = buildTempWorkspace()

mkdirSync(OUT_DIR, { recursive: true })
try {
  for (const [name, args] of CASES) {
    const stdout = runNutrition(args, TEMP_WORKSPACE)
    const text = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n*$/, '\n')
    writeFileSync(join(OUT_DIR, name), text, { encoding: 'utf8' })
    process.stdout.write(`已生成 ${name}（${args.join(' ')}）\n`)
  }
} finally {
  rmSync(TEMP_WORKSPACE, { recursive: true, force: true })
}

/*
 * 合成 TDEE 样本。
 *
 * 仓库里现有记录只有 3 天同时具备体重与摄入，`tdee` 只能给出「数据不足」，
 * 无法覆盖反推算法本身。这里按 `-0.1 kg/天、2100 kcal/天` 造 21 天完美线性数据，
 * 让脚本给出可精确验证的期望值（斜率 -0.1 → 每日能量差 -770 → TDEE 2870）。
 *
 * 合成数据放在系统临时目录，不落进 records/。
 */
const SYNTHETIC_DIR = join(OUT_DIR, 'synthetic')
const SYNTHETIC_DAYS = 21
const SYNTHETIC_START = '2026-09-01'
const SYNTHETIC_KCAL = 2100
const SYNTHETIC_START_WEIGHT = 80
const SYNTHETIC_DAILY_LOSS = 0.1

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const syntheticRecords = []
for (let index = 0; index < SYNTHETIC_DAYS; index += 1) {
  syntheticRecords.push({
    date: addDays(SYNTHETIC_START, index),
    weightAmKg: Number((SYNTHETIC_START_WEIGHT - index * SYNTHETIC_DAILY_LOSS).toFixed(1)),
    kcal: SYNTHETIC_KCAL
  })
}

function syntheticRecordText(record) {
  const weekday = '一二三四五六日'[(new Date(`${record.date}T00:00:00Z`).getUTCDay() + 6) % 7]
  return `---
date: ${record.date}
weekday: ${weekday}
weight_am_kg: ${record.weightAmKg}
weight_pm_kg:
sleep_hours:
energy:
soreness:
---

# ${record.date} ${weekday} 每日记录

## 摄入

| 餐次 | 菜品/做法 | 食材 | 份量 | 热量(kcal) | 蛋白(g) | 脂肪(g) | 碳水(g) | 纤维(g) | 钠(mg) |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 早餐 | 合成餐 | 合成食材 | 100g | ${record.kcal} | 150 | 60 | 200 | 10 | 1000 |

## 训练

| 时间 | 类型 | 时长(min) | RPE | 目标肌群 | 动作 | 组x次x重量 | 估算消耗(kcal) |
| --- | --- | ---: | ---: | --- | --- | --- | ---: |
`
}

mkdirSync(SYNTHETIC_DIR, { recursive: true })
writeFileSync(
  join(SYNTHETIC_DIR, 'tdee-records.json'),
  `${JSON.stringify(syntheticRecords, null, 2)}\n`,
  { encoding: 'utf8' }
)

const tempRoot = mkdtempSync(join(tmpdir(), 'thin-muscle-tdee-'))
try {
  mkdirSync(join(tempRoot, 'scripts'), { recursive: true })
  mkdirSync(join(tempRoot, 'records'), { recursive: true })
  copyFileSync(SCRIPT, join(tempRoot, 'scripts', 'nutrition.py'))
  writeFileSync(
    join(tempRoot, 'targets.md'),
    '---\ntarget_rate_kg_per_week: -0.5\n---\n',
    { encoding: 'utf8' }
  )
  for (const record of syntheticRecords) {
    writeFileSync(join(tempRoot, 'records', `${record.date}.md`), syntheticRecordText(record), {
      encoding: 'utf8'
    })
  }
  const stdout = execFileSync(
    LAUNCHER[0],
    [...LAUNCHER.slice(1), join(tempRoot, 'scripts', 'nutrition.py'), 'tdee', '--days', '28'],
    { cwd: tempRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  )
  const text = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n*$/, '\n')
  writeFileSync(join(OUT_DIR, 'expected-tdee-synthetic.txt'), text, { encoding: 'utf8' })
  process.stdout.write('已生成 expected-tdee-synthetic.txt（合成 21 天，tdee --days 28）\n')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
