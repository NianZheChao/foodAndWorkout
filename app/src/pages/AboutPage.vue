<script setup lang="ts">
/**
 * 关于与免责声明（T4.6 / FR-1608 / 需求 §9）。
 *
 * 需求把七条免责声明写成「产品内必须存在」，所以这里**逐条照抄**，不压缩、不摘要 ——
 * 摘要过的安全提示等于没有（比如「持续疲劳…提示就医」这种，删掉就改变了意思）。
 * 页面同时回答另外两个用户会问的问题：数据存在哪、模型的数字能不能信。
 *
 * 内容与 `docs/pwa-requirements.md` §9 一一对应；改这里要同步改需求文档，
 * 由 `tests/about-page.spec.ts` 钉住七条都在。
 */

import AppHeader from '@/components/AppHeader.vue'
import { APP_VERSION } from '@/app/version'
import { SCHEMA_VERSION } from '@/data/db'

/** 需求 §9 的七条，顺序也照原文。 */
const DISCLAIMERS: string[] = [
  '本产品提供的是基于公开营养学与训练学常识的记录工具与建议，不构成医疗建议。',
  '有基础疾病、进食障碍、孕期或伤痛的，先咨询医生或注册营养师。',
  '体重变化建议控制在每周 0.5%~1% 体重以内，不长期执行极端低热量饮食。',
  '热量长期明显低于目标时，主动提示肌肉流失与 TDEE 下降风险。',
  '出现持续疲劳、睡眠障碍、月经异常、关节疼痛、肿热麻木、尿色变深等情况，提示就医，不继续加量。',
  '模型生成的营养数据属于估算，包装标签或用户实测值优先；不要把估算值当成精确数据。',
  '模型由用户自行配置，其可用性、准确性与费用由用户与其服务提供方决定。'
]
</script>

<template>
  <section class="page">
    <AppHeader title="关于与免责声明" subtitle="数据只在本机；估算值不等于医疗建议" back />

    <div class="card">
      <h2 class="card-title">免责声明与安全提示</h2>
      <ul class="hint-list">
        <li v-for="item in DISCLAIMERS" :key="item">{{ item }}</li>
      </ul>
      <p class="muted">全文出处：需求文档 §9（<code>docs/pwa-requirements.md</code>）。</p>
    </div>

    <div class="card">
      <h2 class="card-title">数据存在哪</h2>
      <ul class="hint-list">
        <li>记录、食物库、报告、目标、档案、设置都在<strong>这台设备</strong>的浏览器数据库（IndexedDB）里。</li>
        <li>没有后端、也没有账号：除了你自己触发的模型请求，应用不向任何第三方发送数据。</li>
        <li>换设备靠「数据」页导出 / 导入；<strong>卸载或清除站点数据之前先导出</strong>一次，否则数据找不回来。</li>
        <li>模型 token 只存本机：不进导出包、不写日志、也不在错误提示里回显。</li>
      </ul>
      <div class="actions">
        <van-button size="small" plain block @click="$router.push('/data')">去「数据」页导出</van-button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">估算值的边界</h2>
      <ul class="hint-list">
        <li>模型补全的营养值是<strong>估算</strong>：包装标签、称重实测或官方数据优先。</li>
        <li>热量与蛋白目标是本地算出来的区间，不是处方；身体反应（体重趋势、精力、恢复）才是判据。</li>
        <li>应用只记录与汇总，不诊断、不替代医生或注册营养师。</li>
      </ul>
    </div>

    <div class="card">
      <h2 class="card-title">版本</h2>
      <div class="kv">
        <span class="kv-key">应用版本</span>
        <span class="kv-value">{{ APP_VERSION }}</span>
      </div>
      <div class="kv">
        <span class="kv-key">数据库 schema</span>
        <span class="kv-value">v{{ SCHEMA_VERSION }}</span>
      </div>
      <p class="muted">
        出问题时可以在「数据」页导出诊断信息（版本、存储占用、最近的错误），那份文件里没有你的记录与 token。
      </p>
    </div>
  </section>
</template>
