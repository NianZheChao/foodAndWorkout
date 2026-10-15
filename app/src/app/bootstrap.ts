import { db } from '@/data/db'
import { getMeta, META_KEYS, setMeta } from '@/data/meta'
import { countFoods, seedFoods } from '@/data/repositories/foods'
import { foodSeed, FOOD_SEED_VERSION } from '@/data/seed'
import { ensureSettings } from './settings'

export interface BootReport {
  seeded: number
  skipped: number
  totalFoods: number
  firstRun: boolean
}

/**
 * 启动流程：打开数据库（含版本迁移）→ 首次写入种子食物库 → 确保单例设置存在。
 * 迁移在 Dexie 打开时自动执行，失败会抛出，由调用方展示错误（design §4.3）。
 */
export async function initializeApp(): Promise<BootReport> {
  await db.open()
  await setMeta(META_KEYS.schemaVersion, db.verno)

  await ensureSettings()

  const seededVersion = await getMeta<string>(META_KEYS.seedVersion)
  const firstRun = !seededVersion
  let seeded = 0
  let skipped = 0
  if (seededVersion !== FOOD_SEED_VERSION) {
    const result = await seedFoods(foodSeed, FOOD_SEED_VERSION)
    seeded = result.inserted
    skipped = result.skipped
    await setMeta(META_KEYS.seedVersion, FOOD_SEED_VERSION)
    await setMeta(META_KEYS.seededAt, Date.now())
  }

  return { seeded, skipped, totalFoods: await countFoods(), firstRun }
}