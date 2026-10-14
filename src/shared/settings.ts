/**
 * 设置 schema / 默认值 / 白名单（Host、Client 两半共享）。
 * 持久化由 Host 半经 ctx.settings 写入 settings.yaml；Client 只经路由读写。
 */

export const SETTINGS_NAMESPACE = 'ui-anime-companion'

export const ENTRY_ID = 'dsh-anime-companion'

export const SETTINGS_FIELDS = [
  'enabled',
  'avatarVisible',
  'avatarSize',
  'avatarOffsetX',
  'avatarOffsetY',
  'themeId',
  'themeMode',
  'modelId',
  'ttsEnabled',
  'ttsEngine',
  'speakMode',
  'voiceName',
  'rate',
  'pitch',
  'volume',
  'mouthSync',
  'expressionLink',
  'splash',
] as const

export type ThemeMode = 'light' | 'dark' | 'system'
export type SpeakMode = 'off' | 'final' | 'manual'
export type TtsEnginePref = 'auto' | 'speechsynthesis' | 'edge' | 'piper'

export interface CompanionSettings {
  enabled: boolean
  avatarVisible: boolean
  avatarSize: number
  avatarOffsetX: number
  avatarOffsetY: number
  themeId: string
  themeMode: ThemeMode
  modelId: string
  ttsEnabled: boolean
  ttsEngine: TtsEnginePref
  speakMode: SpeakMode
  voiceName: string
  rate: number
  pitch: number
  volume: number
  mouthSync: boolean
  expressionLink: boolean
  splash: boolean
}

export const DEFAULT_SETTINGS: CompanionSettings = {
  enabled: true,
  avatarVisible: true,
  avatarSize: 300,
  avatarOffsetX: 0,
  avatarOffsetY: 0,
  themeId: 'example',
  themeMode: 'system',
  modelId: 'example',
  ttsEnabled: true,
  ttsEngine: 'auto',
  speakMode: 'final',
  voiceName: '',
  rate: 1,
  pitch: 1,
  volume: 1,
  mouthSync: true,
  expressionLink: true,
  splash: true,
}

export const NUM_BOUNDS: Record<string, { min: number; max: number }> = {
  avatarSize: { min: 120, max: 640 },
  avatarOffsetX: { min: -4000, max: 4000 },
  avatarOffsetY: { min: -4000, max: 4000 },
  rate: { min: 0.5, max: 2 },
  pitch: { min: 0, max: 2 },
  volume: { min: 0, max: 1 },
}

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system']
const SPEAK_MODES: SpeakMode[] = ['off', 'final', 'manual']
const ENGINE_PREFS: TtsEnginePref[] = ['auto', 'speechsynthesis', 'edge', 'piper']

export function pickKnown(section: Record<string, unknown>): Partial<CompanionSettings> {
  const out: Record<string, unknown> = {}
  for (const key of SETTINGS_FIELDS) {
    if (key in section) out[key] = section[key]
  }
  return out as Partial<CompanionSettings>
}

export function resolveSettings(partial?: Partial<CompanionSettings> | null): CompanionSettings {
  return { ...DEFAULT_SETTINGS, ...(partial ?? {}) }
}

export function validateSettings(body: Record<string, unknown>): string | null {
  for (const [key, { min, max }] of Object.entries(NUM_BOUNDS)) {
    const v = body[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return `invalid-range:${key}`
  }
  const bools = [
    'enabled',
    'avatarVisible',
    'ttsEnabled',
    'mouthSync',
    'expressionLink',
    'splash',
  ]
  for (const k of bools) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') return `invalid-bool:${k}`
  }
  const strings = ['themeId', 'modelId', 'voiceName']
  for (const k of strings) {
    if (body[k] !== undefined && typeof body[k] !== 'string') return `invalid-string:${k}`
  }
  if (body.themeMode !== undefined && !THEME_MODES.includes(body.themeMode as ThemeMode)) return 'invalid-themeMode'
  if (body.speakMode !== undefined && !SPEAK_MODES.includes(body.speakMode as SpeakMode)) return 'invalid-speakMode'
  if (body.ttsEngine !== undefined && !ENGINE_PREFS.includes(body.ttsEngine as TtsEnginePref)) return 'invalid-ttsEngine'
  return null
}
