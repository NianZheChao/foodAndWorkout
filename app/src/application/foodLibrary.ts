/** 食物库的查找与「给模型看的名字清单」。不涉及网络，纯本地（DR-40 / FR-1408）。 */

import { listFoods, findByNormalizedName } from '@/data/repositories/foods'
import { baseNameOf, normalizeFoodName, parenOf } from '@/domain/foodName'
import type { Food } from '@/domain/types'

/** 括号里是否含生熟 / 干湿 / 做法这类「等于结论」的限定语。 */
const STATE_QUALIFIER_RE = /生|熟|干|市售|水煮|烤|炸|炒|煮|蒸|卤/

function hasStateQualifier(qualifier: string): boolean {
  return STATE_QUALIFIER_RE.test(qualifier)
}

/**
 * 先按归一化全名精确命中；再退回「主名相同」，但**必须没有歧义**。
 *
 * 括号里的内容往往是区别本身（`面条(干)` 约 350 kcal，`面条(煮熟)` 只有 109 kcal），
 * 所以这里两条硬规矩：
 * 1. 名字里带生熟 / 干湿 / 做法（生、熟、干、市售、水煮…）时一律不做模糊匹配，
 *    括号对不上就是没有；
 * 2. 主名能命中多条却数值不同时也不猜——只有「命中多条但数值完全一致」（如
 *    `鸡蛋(全蛋 生)` 与 `鸡蛋(水煮)`）才允许随便取一条。
 *
 * 猜错食物比多问一句贵得多（DR-47），所以宁可返回 undefined 让它去问模型。
 */
export async function findFoodFuzzy(name: string): Promise<Food | undefined> {
  const exact = await findByNormalizedName(name)
  if (exact) return exact
  const target = normalizeFoodName(baseNameOf(name))
  if (!target) return undefined
  if (hasStateQualifier(parenOf(name))) return undefined
  const all = await listFoods()
  const candidates = all.filter((food) => normalizeFoodName(baseNameOf(food.name)) === target)
  if (!candidates.length) return undefined
  const [first] = candidates
  const identical = candidates.every(
    (food) =>
      food.kcal === first.kcal &&
      food.proteinG === first.proteinG &&
      food.fatG === first.fatG &&
      food.carbG === first.carbG &&
      food.fiberG === first.fiberG &&
      food.sodiumMg === first.sodiumMg
  )
  return identical ? first : undefined
}

/**
 * 从用户输入里挑出「库里已知的名字」，只给名称、不给数值。
 *
 * 目的是让模型优先复用库里的标准名，这样大部分条目根本不用再走 `food.resolve`（FR-1408）。
 */
export async function suggestKnownFoods(text: string, limit = 30): Promise<string[]> {
  if (!text.trim()) return []
  const all = await listFoods()
  const hits: string[] = []
  for (const food of all) {
    const base = baseNameOf(food.name)
    if (base.length < 2 || !text.includes(base)) continue
    hits.push(food.name)
    if (hits.length >= limit) break
  }
  return hits
}
