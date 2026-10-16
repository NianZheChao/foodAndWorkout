/**
 * 食物名称归一化：用于去重、检索与模型返回名称的匹配。
 *
 * 重要：**必须保留括号内容**。库里的括号往往承载区分信息
 * （鸡蛋(全蛋 生) vs 鸡蛋(水煮)、牛奶(全脂 市售) vs 牛奶(脱脂 市售)），
 * 去掉括号会让多个不同食物塌缩成同一个 key，造成静默的错配。
 * 这里只统一全半角括号、去掉空白、统一大小写。
 */
export function normalizeFoodName(raw: string): string {
  return raw
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[\s\u3000]/g, '')
    .replace(/[·・]+$/g, '')
    .toLowerCase()
}

/** 酒精类：热量主要来自乙醇（7 kcal/g），宏量反算会明显偏低。 */
export function isAlcoholic(name: string): boolean {
  return /啤酒|白酒|红酒|黄酒|米酒|葡萄酒|清酒|威士忌|伏特加|朗姆|鸡尾酒|酒精/.test(name)
}

/** 去掉括号里的限定语：`鸡蛋(全蛋 生)` → `鸡蛋`。用于「一句话里提到了它」这种粗匹配。 */
export function baseNameOf(name: string): string {
  return name.replace(/[（(].*$/, '').trim()
}

/** 括号里的限定语；没有括号返回空串。 */
export function parenOf(name: string): string {
  const matched = /[（(]([^)）]*)[)）]/.exec(name)
  return matched ? matched[1].trim() : ''
}

/**
 * 「疑似重复」分组用的宽松键：去掉括号限定语后归一化。
 *
 * 与 `normalizeFoodName` 的区别是**故意丢掉括号内容** —— 分组要的是"可能是同一样东西"，
 * 括号里的生熟 / 全脂脱脂是不是真的区别，由用户看着数值自己判断（FR-408 只要求"提醒"）。
 */
export function looseFoodKey(name: string): string {
  return normalizeFoodName(baseNameOf(name))
}
