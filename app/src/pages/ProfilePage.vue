<script setup lang="ts">
/**
 * 档案（M10 / FR-1000）。
 *
 * 这里放的是**长期事实**：不因为某一天吃多了、练少了就改它（FR-1002）。
 * 忌口 / 过敏 / 可用器材会被推荐模块读取（FR-1003），所以「没有」也要显式写出来。
 * 界面上不存在食材库存的入口（FR-1005，2026-10-12 起）。
 */

import { computed, onMounted, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import { useRouter } from 'vue-router'
import { getProfile, saveProfile } from '@/data/repositories/profile'
import { isPlausibleWeight } from '@/domain/weight'
import type { ProfileRecord } from '@/domain/types'

/** 记录口径约定：与工作区 README / profile.md 的既有约定一致，可改可删。 */
const DEFAULT_CONVENTIONS = [
  '体重默认口径：晨起排尿后、空腹',
  '不记录饮水（不用报喝了多少水）',
  '不记录食材库存（不用报家里还有什么、买了什么）'
]

/** 调味料有无：键名与 profile.md 的表格一致，方便日后导入导出对得上。 */
const SEASONING_ITEMS = [
  '盐',
  '食用油',
  '生抽 / 老抽',
  '醋',
  '料酒',
  '蚝油',
  '糖 / 蜂蜜',
  '黑胡椒',
  '辣椒 / 豆瓣酱',
  '蒜、姜、葱',
  '淀粉'
]

const EQUIPMENT_ITEMS = [
  '哑铃',
  '杠铃',
  '跑步机 / 单车',
  '划船机',
  '厨房秤',
  '引体向上杆',
  '弹力带'
]

const SEX_OPTIONS: ProfileRecord['sex'][] = ['male', 'female']
const GOAL_OPTIONS: ProfileRecord['goal'][] = ['减脂', '增肌', '重组']
const LEVEL_OPTIONS: ProfileRecord['trainingLevel'][] = ['新手', '中级', '高级']

const router = useRouter()
const saved = shallowRef<ProfileRecord>()
const errorMessage = ref('')
/** 读完库再渲染表单，避免把「还没读到」误当成「第一次填写」。 */
const loaded = ref(false)

interface ProfileForm {
  name: string
  sex: ProfileRecord['sex']
  age: string
  heightCm: string
  weightKg: string
  bodyFatPct: string
  goal: ProfileRecord['goal']
  trainingLevel: ProfileRecord['trainingLevel']
  trainingYears: string
  injuries: string
  allergies: string
  dietType: string
  dailyCookMinutes: string
  budgetPerDayCny: string
  wakeTime: string
  sleepTime: string
  seasonings: Record<string, boolean>
  equipment: string[]
  conventionsText: string
  mutedFieldsText: string
}

function blankForm(): ProfileForm {
  return {
    name: '',
    sex: 'male',
    age: '',
    heightCm: '',
    weightKg: '',
    bodyFatPct: '',
    goal: '减脂',
    trainingLevel: '新手',
    trainingYears: '',
    injuries: '',
    allergies: '',
    dietType: '',
    dailyCookMinutes: '30',
    budgetPerDayCny: '',
    wakeTime: '',
    sleepTime: '',
    seasonings: {},
    equipment: [],
    conventionsText: DEFAULT_CONVENTIONS.join('\n'),
    mutedFieldsText: ''
  }
}

const form = ref<ProfileForm>(blankForm())

const seasoningsSelected = computed({
  get: () => Object.entries(form.value.seasonings).filter(([, has]) => has).map(([name]) => name),
  set: (names: string[]) => {
    form.value.seasonings = Object.fromEntries(SEASONING_ITEMS.map((name) => [name, names.includes(name)]))
  }
})

function syncForm(record: ProfileRecord): void {
  form.value = {
    name: record.name ?? '',
    sex: record.sex,
    age: String(record.age),
    heightCm: String(record.heightCm),
    weightKg: String(record.weightKg),
    bodyFatPct: record.bodyFatPct === undefined ? '' : String(record.bodyFatPct),
    goal: record.goal,
    trainingLevel: record.trainingLevel,
    trainingYears: record.trainingYears === undefined ? '' : String(record.trainingYears),
    injuries: record.injuries ?? '',
    allergies: record.allergies ?? '',
    dietType: record.dietType ?? '',
    dailyCookMinutes: String(record.dailyCookMinutes),
    budgetPerDayCny: record.budgetPerDayCny === undefined ? '' : String(record.budgetPerDayCny),
    wakeTime: record.wakeTime ?? '',
    sleepTime: record.sleepTime ?? '',
    seasonings: Object.fromEntries(SEASONING_ITEMS.map((name) => [name, record.seasonings?.[name] ?? false])),
    equipment: [...(record.equipment ?? [])],
    conventionsText: (record.conventions ?? []).join('\n'),
    mutedFieldsText: (record.mutedFields ?? []).join('\n')
  }
}

async function load(): Promise<void> {
  const record = await getProfile()
  saved.value = record
  if (record) syncForm(record)
  loaded.value = true
}

onMounted(load)

const isFirstTime = computed(() => !saved.value)

/** 一行一条，去掉空行与重复。 */
function toLines(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))]
}

async function save(): Promise<void> {
  errorMessage.value = ''
  const age = Number(form.value.age)
  const heightCm = Number(form.value.heightCm)
  const weightKg = Number(form.value.weightKg)
  const dailyCookMinutes = Number(form.value.dailyCookMinutes)

  if (!Number.isFinite(age) || age < 10 || age > 100) {
    errorMessage.value = '年龄要填 10-100 之间的数字。'
    return
  }
  if (!Number.isFinite(heightCm) || heightCm < 100 || heightCm > 250) {
    errorMessage.value = '身高要填 100-250 cm 之间的数字。'
    return
  }
  if (!isPlausibleWeight(weightKg)) {
    errorMessage.value = '体重要填 25-300 kg 之间的数字。'
    return
  }
  if (!Number.isFinite(dailyCookMinutes) || dailyCookMinutes < 0 || dailyCookMinutes > 600) {
    errorMessage.value = '每餐可投入时间要填 0-600 分钟之间的数字。'
    return
  }

  const bodyFatPct = form.value.bodyFatPct.trim() ? Number(form.value.bodyFatPct) : undefined
  const trainingYears = form.value.trainingYears.trim() ? Number(form.value.trainingYears) : undefined
  const budgetPerDayCny = form.value.budgetPerDayCny.trim() ? Number(form.value.budgetPerDayCny) : undefined
  if (bodyFatPct !== undefined && (!Number.isFinite(bodyFatPct) || bodyFatPct < 3 || bodyFatPct > 60)) {
    errorMessage.value = '体脂率要填 3-60 之间的数字（不清楚就留空）。'
    return
  }

  const record: ProfileRecord = {
    id: 'current',
    name: form.value.name.trim() || undefined,
    sex: form.value.sex,
    age,
    heightCm,
    weightKg,
    bodyFatPct,
    goal: form.value.goal,
    trainingLevel: form.value.trainingLevel,
    trainingYears,
    injuries: form.value.injuries.trim() || undefined,
    allergies: form.value.allergies.trim() || undefined,
    dietType: form.value.dietType.trim() || undefined,
    dailyCookMinutes,
    budgetPerDayCny,
    wakeTime: form.value.wakeTime.trim() || undefined,
    sleepTime: form.value.sleepTime.trim() || undefined,
    seasonings: Object.fromEntries(SEASONING_ITEMS.map((name) => [name, form.value.seasonings[name] ?? false])),
    equipment: [...form.value.equipment],
    conventions: toLines(form.value.conventionsText),
    mutedFields: toLines(form.value.mutedFieldsText),
    updatedAt: Date.now()
  }
  await saveProfile(record)
  saved.value = await getProfile()
  if (saved.value) syncForm(saved.value)
  showToast({ message: '档案已保存到本机', position: 'bottom' })
}
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <h1 class="page-title">档案</h1>
    <p class="page-subtitle">长期事实，只在真正变化时改；不因为某一天的饮食或训练而改动。</p>

    <div class="card">
      <h2 class="card-title">{{ isFirstTime ? '第一次填写' : '基础' }}</h2>
      <van-field v-model="form.name" label="称呼" placeholder="可以留空" />
      <van-field label="性别">
        <template #input>
          <van-radio-group v-model="form.sex" direction="horizontal">
            <van-radio v-for="option in SEX_OPTIONS" :key="option" :name="option">
              {{ option === 'male' ? '男' : '女' }}
            </van-radio>
          </van-radio-group>
        </template>
      </van-field>
      <van-field v-model="form.age" label="年龄" type="number" placeholder="例如 26" />
      <van-field v-model="form.heightCm" label="身高(cm)" type="number" placeholder="例如 173" />
      <van-field v-model="form.weightKg" label="体重(kg)" type="number" placeholder="起始/当前体重" />
      <van-field v-model="form.bodyFatPct" label="体脂率(%)" type="number" placeholder="不清楚就留空" />
      <van-field label="阶段目标">
        <template #input>
          <van-radio-group v-model="form.goal" direction="horizontal">
            <van-radio v-for="option in GOAL_OPTIONS" :key="option" :name="option">{{ option }}</van-radio>
          </van-radio-group>
        </template>
      </van-field>
      <van-field label="训练水平">
        <template #input>
          <van-radio-group v-model="form.trainingLevel" direction="horizontal">
            <van-radio v-for="option in LEVEL_OPTIONS" :key="option" :name="option">{{ option }}</van-radio>
          </van-radio-group>
        </template>
      </van-field>
      <van-field v-model="form.trainingYears" label="训练年限" type="number" placeholder="可以留空" />
      <p class="muted">阶段目标与训练水平会决定首次热量估算的活动系数与调整幅度。</p>
    </div>

    <div class="card">
      <h2 class="card-title">约束与偏好</h2>
      <van-field v-model="form.injuries" label="伤病 / 疼痛史" placeholder="没有就写「无」" />
      <van-field v-model="form.allergies" label="过敏原" placeholder="没有就写「无」" />
      <van-field v-model="form.dietType" label="忌口 / 饮食类型" placeholder="如素食、乳糖不耐；没有写「无特殊」" />
      <van-field v-model="form.dailyCookMinutes" label="每餐可做饭(分钟)" type="number" />
      <van-field v-model="form.budgetPerDayCny" label="每日餐饮预算(元)" type="number" placeholder="可以留空" />
      <p class="muted">这几项会被推荐模块直接读取：忌口与过敏食材不会出现在推荐里，做饭时间会限制做法复杂度。</p>
    </div>

    <div class="card">
      <h2 class="card-title">调味料有无</h2>
      <van-checkbox-group v-model="seasoningsSelected">
        <van-checkbox v-for="item in SEASONING_ITEMS" :key="item" :name="item" class="check-row">
          {{ item }}
        </van-checkbox>
      </van-checkbox-group>
      <p class="muted">勾上「手头有 / 常用」的；没勾的会按「需要买」处理。</p>
    </div>

    <div class="card">
      <h2 class="card-title">可用器材</h2>
      <van-checkbox-group v-model="form.equipment">
        <van-checkbox v-for="item in EQUIPMENT_ITEMS" :key="item" :name="item" class="check-row">
          {{ item }}
        </van-checkbox>
      </van-checkbox-group>
      <p class="muted">只勾真正能用的：训练推荐不会安排用不到的器材。</p>
    </div>

    <div class="card">
      <h2 class="card-title">作息</h2>
      <van-field v-model="form.wakeTime" label="起床时间" placeholder="09:00" />
      <van-field v-model="form.sleepTime" label="入睡时间" placeholder="01:00" />
    </div>

    <div class="card">
      <h2 class="card-title">记录口径约定</h2>
      <van-field
        v-model="form.conventionsText"
        type="textarea"
        rows="4"
        autosize
        label=""
        placeholder="一行一条"
      />
      <p class="muted">
        长期约定，例如「不记录饮水」「不记录食材库存」「体重默认晨起排尿后空腹」。写在这里的字段，记录流程不会再追问。
      </p>
      <h2 class="card-title">不再追问的字段</h2>
      <van-field v-model="form.mutedFieldsText" type="textarea" rows="2" autosize label="" placeholder="一行一条，例如 油.grams" />
      <p class="muted">与「不再追问」名单一致：写进来的字段不会再生成澄清问题（DR-47）。</p>
    </div>

    <p class="muted">档案会参与首次目标估算、推荐与提醒；改完记得保存。目标值不在这里改，去「目标」页。</p>
    <p v-if="errorMessage" class="muted warn-text">{{ errorMessage }}</p>

    <div class="actions">
      <van-button type="primary" block @click="save">保存档案</van-button>
      <van-button plain type="primary" block @click="router.push('/targets')">去目标与校准</van-button>
    </div>
  </section>
</template>

<style scoped>
.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.check-row {
  margin: 6px 0;
}

.warn-text {
  color: var(--warn);
}
</style>
