import type { SeedFood } from '@/data/repositories/foods'
import { FOOD_SEED_ROWS, FOOD_SEED_VERSION } from './foods.seed'

export { FOOD_SEED_VERSION }

/** 内置初始食物库：由工作区 data/foods.csv 构建期生成（FR-401）。 */
export const foodSeed: SeedFood[] = FOOD_SEED_ROWS