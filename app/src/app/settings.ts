import { getSettings, saveSettings } from '@/data/repositories/settings'
import type { SettingsRecord } from '@/domain/types'

export async function ensureSettings(): Promise<SettingsRecord> {
  return getSettings()
}

export { getSettings, saveSettings }