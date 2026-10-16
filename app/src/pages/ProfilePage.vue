<script setup lang="ts">
/**
 * 档案（M10 / FR-1000）。
 *
 * 这里放的是**长期事实**：不因为某一天吃多了、练少了就改它（FR-1002）。
 * 只保留**真的会被读**的字段：性别 / 年龄 / 身高 / 体重 / 目标 / 训练水平 供首次目标估算使用
 * （`domain/calibration.ts`），「不再追问的字段」直接写 `settings.mutedFields`
 * —— 澄清引擎读的就是它（`application/logParse.ts`）。
 *
 * 其中四项是「生成式推荐」（B 级，默认关）的**安全边界**（T3.8 / FR-1003）：忌口 / 过敏 /
 * 可用器材 / 每餐时间。2026-10-16 的档案瘦身删掉过它们（当时判断不做推荐），B 级重新立项后按
 * FR-1003 恢复；四项没填齐，设置页里那个开关就打不开。界面上不存在食材库存的入口（FR-1005）。
 */

import { computed, onMounted, ref, shallowRef } from 'vue'
import { showToast } from 'vant'
import { useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import { getProfile, saveProfile } from '@/data/repositories/profile'
import { getSettings, saveSettings } from '@/data/repositories/settings'
import { parseConstraintList } from '@/domain/recommend'
import { isPlausibleWeight } from '@/domain/weight'
import type { ProfileRecord } from '@/domain/types'

/** 记录口径约定：与工作区 README / profile.md 的既有约定一致，可改可删。 */
const DEFAULT_CONVENTIONS = [
  '体重默认口径：晨起排尿后、空腹',
  '不记录饮水（不用报喝了多少水）',
  '不记录食材库存（不用报家里还有什么、买了什么）'
]

const SEX_OPTIONS: ProfileRecord['sex'][] = ['male', 'female']
const GOAL_OPTIONS: ProfileRecord['goal'][] = ['减脂', '增肌', '重组']
const LEVEL_OPTIONS: ProfileRecord['trainingLevel'][] = ['新手', '中级', '高级']

const router = useRouter()
const saved = shallowRef<ProfileRecord>()
/** 「不再追问」名单存在 settings 里（澄清引擎读的就是那儿），不在档案里 */
const mutedFieldsText = ref('')
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
  wakeTime: string
  sleepTime: string
  conventionsText: string
  avoidFoodsText: string
  allergiesText: string
  equipmentText: string
  mealMinutes: string
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
    wakeTime: '',
    sleepTime: '',
    conventionsText: DEFAULT_CONVENTIONS.join('\n'),
    avoidFoodsText: '',
    allergiesText: '',
    equipmentText: '',
    mealMinutes: ''
  }
}

const form = ref<ProfileForm>(blankForm())

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
    wakeTime: record.wakeTime ?? '',
    sleepTime: record.sleepTime ?? '',
    conventionsText: (record.conventions ?? []).join('\n'),
    avoidFoodsText: (record.avoidFoods ?? []).join('\n'),
    allergiesText: (record.allergies ?? []).join('\n'),
    equipmentText: (record.equipment ?? []).join('\n'),
    mealMinutes: record.mealMinutes === undefined ? '' : String(record.mealMinutes)
  }
}

async function load(): Promise<void> {
  const [record, settings] = await Promise.all([getProfile(), getSettings()])
  saved.value = record
  mutedFieldsText.value = (settings.mutedFields ?? []).join('\n')
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

  const bodyFatPct = form.value.bodyFatPct.trim() ? Number(form.value.bodyFatPct) : undefined
  const trainingYears = form.value.trainingYears.trim() ? Number(form.value.trainingYears) : undefined
  if (bodyFatPct !== undefined && (!Number.isFinite(bodyFatPct) || bodyFatPct < 3 || bodyFatPct > 60)) {
    errorMessage.value = '体脂率要填 3-60 之间的数字（不清楚就留空）。'
    return
  }

  const mealMinutes = form.value.mealMinutes.trim() ? Number(form.value.mealMinutes) : undefined
  if (mealMinutes !== undefined && (!Number.isFinite(mealMinutes) || mealMinutes < 5 || mealMinutes > 180)) {
    errorMessage.value = '每餐时间要填 5-180 分钟之间的数字（不清楚就留空）。'
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
    wakeTime: form.value.wakeTime.trim() || undefined,
    sleepTime: form.value.sleepTime.trim() || undefined,
    conventions: toLines(form.value.conventionsText),
    // 四项安全边界（FR-1003）：多行 / 逗号 / 顿号都认，去空去重
    avoidFoods: parseConstraintList(form.value.avoidFoodsText),
    allergies: parseConstraintList(form.value.allergiesText),
    equipment: parseConstraintList(form.value.equipmentText),
    mealMinutes,
    updatedAt: Date.now()
  }
  // 「不再追问」名单属于设置（澄清引擎读 settings.mutedFields），与档案分开存
  await saveProfile(record)
  await saveSettings({ mutedFields: toLines(mutedFieldsText.value) })
  saved.value = await getProfile()
  if (saved.value) syncForm(saved.value)
  showToast({ message: '档案已保存到本机', position: 'bottom' })
}
</script>

<template>
  <section class="page" :data-ready="loaded ? 'true' : 'false'">
    <AppHeader
      title="档案"
      subtitle="长期事实，只在真正变化时改；不因为某一天的饮食或训练而改动。"
      back
    />

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
      <van-field v-model="mutedFieldsText" type="textarea" rows="2" autosize label="" placeholder="一行一条，例如 油.grams" />
      <p class="muted">写进来的字段不会再生成澄清问题（DR-47）。这份名单存在设置里，澄清引擎直接读它。</p>
    </div>

    <div class="card">
      <h2 class="card-title">饮食与训练约束</h2>
      <p class="muted">
        这四项是「生成式推荐」（B 级，默认关）的<strong>安全边界</strong>（FR-1003）：四项没填齐，
        设置页里那个开关就打不开 —— 否则可能出现「推荐了你不能吃的东西」。没有忌口 / 过敏就填「无」，
        别留空：留空分不清「没有」和「还没填」。
      </p>
      <van-field
        v-model="form.avoidFoodsText"
        type="textarea"
        rows="2"
        autosize
        label="忌口"
        placeholder="一行一条，例如 香菜 / 内脏；没有就填「无」"
      />
      <van-field
        v-model="form.allergiesText"
        type="textarea"
        rows="2"
        autosize
        label="过敏"
        placeholder="一行一条，例如 虾 / 花生；没有就填「无」"
      />
      <van-field
        v-model="form.equipmentText"
        type="textarea"
        rows="2"
        autosize
        label="可用器材"
        placeholder="一行一件，例如 杠铃 / 哑铃 / 单杠；只有自重就填「自重」"
      />
      <van-field v-model="form.mealMinutes" label="每餐时间(min)" type="number" placeholder="例如 20" />
      <p class="muted">推荐只读这四项约束与本地摘要：不问你家里还有什么（FR-803 / FR-805）。</p>
    </div>

    <p class="muted">档案只参与首次目标估算；改完记得保存。目标值不在这里改，去「目标」页。</p>
    <p v-if="errorMessage" class="muted warn-text">{{ errorMessage }}</p>

    <div class="actions">
      <van-button type="primary" block @click="save">保存档案</van-button>
      <van-button plain type="primary" block @click="router.push('/targets')">去目标与校准</van-button>
    </div>
  </section>
</template>

