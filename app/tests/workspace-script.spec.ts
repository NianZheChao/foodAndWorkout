// @vitest-environment node
/**
 * 工作区文本导出的**验收基准**（docs/pwa-design.md §7.2 / 需求 §13.14，FR-1206）：
 * 把导出结果放进一个临时工作区，真的跑 `python scripts/nutrition.py check --all`；
 * 再让脚本自己 `totals <date> --write` 一遍，把它写出来的 AUTO 区块跟我们写的逐字比对。
 *
 * 没装 Python 的机器整组跳过 —— `npm test` 不该因为某台机器没有 Python 就红；装了就是真跑，
 * 不是「看起来对」。临时工作区用完即删：仓库里不留任何记录文件（AGENTS.md）。
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/data/db'
import { upsertFood } from '@/data/repositories/foods'
import { buildWorkspaceExport, type WorkspaceFile } from '@/io/workspaceExport'
import { fileOf, seedFromFixtures, seedSingletons, seedTrainingDay } from './helpers/workspace'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AUTO_BEGIN = '<!-- AUTO:SUMMARY:BEGIN -->'
const AUTO_END = '<!-- AUTO:SUMMARY:END -->'

const LAUNCHERS = process.platform === 'win32' ? [['python'], ['py', '-3']] : [['python3'], ['python']]

/** 探测可用的 Python 启动器；探测失败即整组跳过。 */
function resolveLauncher(): string[] | undefined {
  for (const launcher of LAUNCHERS) {
    try {
      execFileSync(launcher[0], [...launcher.slice(1), '--version'], { encoding: 'utf8' })
      return launcher
    } catch {
      // 换下一个候选
    }
  }
  return undefined
}

const LAUNCHER = resolveLauncher()

/** 跑脚本。非零退出也把 stdout 带回来：脚本用退出码表达「数据不足」这类业务结论。 */
function runScript(root: string, args: string[]): { status: number; stdout: string } {
  const launcher = LAUNCHER as string[]
  const script = join(root, 'scripts', 'nutrition.py')
  try {
    const stdout = execFileSync(launcher[0], [...launcher.slice(1), script, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
    return { status: 0, stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '' }
  }
}

/** 把导出的文件摊进一个临时工作区（目录结构与仓库一致），返回根目录。 */
function writeWorkspace(files: readonly WorkspaceFile[]): string {
  const root = mkdtempSync(join(tmpdir(), 'thin-muscle-workspace-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(join(REPO, 'scripts', 'nutrition.py'), join(root, 'scripts', 'nutrition.py'))
  for (const file of files) {
    const target = join(root, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.text, { encoding: 'utf8' })
  }
  return root
}

function autoBlock(text: string): string {
  const begin = text.indexOf(AUTO_BEGIN)
  const end = text.indexOf(AUTO_END)
  if (begin < 0 || end < 0) throw new Error('文件里没有 AUTO:SUMMARY 区块')
  return text.slice(begin, end + AUTO_END.length)
}

async function withWorkspace<T>(files: readonly WorkspaceFile[], run: (root: string) => T): Promise<T> {
  const root = writeWorkspace(files)
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe.skipIf(!LAUNCHER)('工作区文本导出：原脚本能直接消费', () => {
  it('python check --all 报 0 个问题', async () => {
    await seedFromFixtures()
    await seedTrainingDay()
    await seedSingletons()
    const files = await buildWorkspaceExport()
    const days = files.filter((file) => file.path.startsWith('records/')).length

    const result = await withWorkspace(files, (root) => runScript(root, ['check', '--all']))
    expect(result.stdout).toContain(`${days} 个文件，0 个问题`)
    expect(result.status).toBe(0)
  })

  // 这条用例**每个日期都 spawn 一次 Python**（fixture 十几个日期），机器忙时会撞上 Vitest 的 5 秒默认超时。
  // 真跑脚本就是要等进程，给宽一点（§8 记过这次踩坑；顺带避免全量并行时误报）。
  it('脚本自己写的 AUTO 区块与我们写的逐字一致', async () => {
    await seedFromFixtures()
    await seedTrainingDay()
    await seedSingletons()
    const files = await buildWorkspaceExport()
    const dates = files
      .filter((file) => file.path.startsWith('records/'))
      .map((file) => file.path.slice('records/'.length, -'.md'.length))

    await withWorkspace(files, (root) => {
      for (const date of dates) {
        const written = runScript(root, ['totals', date, '--write'])
        expect(written.status).toBe(0)
        const onDisk = readFileSync(join(root, 'records', `${date}.md`), 'utf8')
        expect(autoBlock(onDisk), `${date} 的 AUTO 区块`).toBe(autoBlock(fileOf(files, `records/${date}.md`)))
      }
    })
  }, 30_000)

  it('导出的 foods.csv 能被脚本 lookup 认出来（列名、单位、引号都对）', async () => {
    await upsertFood({
      name: '测试,食物名',
      category: '测试',
      unit: '100g',
      kcal: 100,
      proteinG: 10,
      fatG: 2,
      carbG: 3,
      fiberG: 4,
      sodiumMg: 5,
      source: 'manual'
    })
    const files = await buildWorkspaceExport()
    const result = await withWorkspace(files, (root) => runScript(root, ['lookup', '测试,食物名']))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('| 测试,食物名 | 100g | 100 kcal | 10 g | 2 g | 3 g | 4 g | 5 mg |')
  })
})
