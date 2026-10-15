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

/** 从名称中推断生熟状态；推断不出时返回 undefined（不臆造）。 */
export function inferCookedState(name: string): '生' | '熟' | '市售' | undefined {
  if (name.includes('市售')) return '市售'
  if (name.includes('熟') || name.includes('水煮') || name.includes('煮')) return '熟'
  if (name.includes('生')) return '生'
  return undefined
}

/** 酒精类：热量主要来自乙醇（7 kcal/g），宏量反算会明显偏低。 */
export function isAlcoholic(name: string): boolean {
  return /啤酒|白酒|红酒|黄酒|米酒|葡萄酒|清酒|威士忌|伏特加|朗姆|鸡尾酒|酒精/.test(name)
}