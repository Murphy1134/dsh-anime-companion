/**
 * dsh-anime-companion —— Client 半（浏览器入口）。
 * 组合 theme/avatar/capture/speak 四模块 + 自绘 React 设置面板。
 */
import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeManager, type Mode } from './theme/tokens'
import { AvatarManager, type ModelManifest } from './avatar/live2d'
import { FallbackTts } from './speak/tts'
import { SpeakQueue, type VoiceOpts } from './speak/queue'
import { CaptureManager, type CompanionState } from './capture/stream'
import { apiUrl, assetUrl, resolveApiBase, ROUTES } from './shared/protocol'
import {
  DEFAULT_SETTINGS, resolveSettings, type CompanionSettings,
  type SpeakMode, type TtsEnginePref,
} from './shared/settings'

export const inject = ['slots']

async function getSettings(): Promise<CompanionSettings> {
  const r = await fetch(await apiUrl(ROUTES.settings), { credentials: 'same-origin' })
  if (!r.ok) throw new Error(`获取设置失败: HTTP ${r.status}`)
  const j = await r.json()
  return resolveSettings(j?.value)
}
async function postSettings(patch: Partial<CompanionSettings>): Promise<CompanionSettings> {
  const r = await fetch(await apiUrl(ROUTES.settings), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(patch),
  })
  if (!r.ok) throw new Error(`保存设置失败: HTTP ${r.status}`)
  const j = await r.json()
  return resolveSettings(j?.value)
}
async function listModels(): Promise<ModelManifest[]> {
  const r = await fetch(await apiUrl(ROUTES.models), { credentials: 'same-origin' })
  if (!r.ok) return []
  const j = await r.json()
  return (j?.items ?? []) as ModelManifest[]
}
async function listThemes(): Promise<any[]> {
  const r = await fetch(await apiUrl(ROUTES.themes), { credentials: 'same-origin' })
  if (!r.ok) return []
  const j = await r.json()
  return (j?.items ?? []) as any[]
}
async function fetchThemeCss(id: string): Promise<string> {
  const r = await fetch(assetUrl(`themes/${id}/style.css`), { credentials: 'same-origin' })
  return r.ok ? r.text() : ''
}

class CompanionApp {
  ctx: any
  settings: CompanionSettings = { ...DEFAULT_SETTINGS }
  models: ModelManifest[] = []
  themes: any[] = []
  theme = new ThemeManager()
  avatar = new AvatarManager()
  tts = new FallbackTts()
  queue!: SpeakQueue
  capture!: CaptureManager
  panelRoot: any = null
  toolbarEl: HTMLElement | null = null

  constructor(ctx: any) {
    this.ctx = ctx
  }

  voiceOpts(): VoiceOpts {
    return {
      voiceName: this.settings.voiceName,
      engine: this.settings.ttsEngine,
      rate: this.settings.rate,
      pitch: this.settings.pitch,
      volume: this.settings.volume,
    }
  }

  async start(): Promise<void> {
    await resolveApiBase()
    try {
      this.settings = await getSettings()
    } catch (e) {
      console.warn('[anime-companion] 设置读取失败，使用默认值：', e)
    }
    const [models, themes] = await Promise.all([listModels(), listThemes()])
    this.models = models
    this.themes = themes

    this.theme.attach(this.ctx)
    await this.applyTheme()

    this.avatar.mount(document.body, (x, y) => {
      void this.update({ avatarOffsetX: x, avatarOffsetY: y })
    })
    this.avatar.setSize(this.settings.avatarSize)
    this.avatar.setOffset(this.settings.avatarOffsetX, this.settings.avatarOffsetY)
    this.avatar.setVisible(this.settings.avatarVisible)
    await this.loadCurrentModel()

    this.queue = new SpeakQueue(
      this.tts,
      (level) => this.settings.mouthSync && this.avatar.setMouth(level),
      () => {},
    )
    this.capture = new CaptureManager({
      onState: (s: CompanionState) => {
        if (this.settings.expressionLink) this.avatar.setState(s)
      },
      onFinalText: (id, text) => {
        if (this.settings.ttsEnabled && this.settings.speakMode === 'final') {
          this.queue.enqueueMessage(id, text, this.voiceOpts())
        }
      },
    })
    this.capture.attach(this.ctx)

    this.mountToolbar()
    this.tryHeaderSlot()
    this.hideSplash()

    ;(window as any).__animeCompanion = {
      app: this,
      setState: (s: CompanionState) => this.avatar.setState(s),
      speak: (text: string) => this.queue.enqueueMessage(`manual-${Date.now()}`, text, this.voiceOpts(), true),
      stop: () => this.queue.stop(),
    }
  }

  hideSplash(): void {
    const el = document.getElementById('anime-companion-boot')
    if (!el) return
    el.classList.add('hide')
    setTimeout(() => el.remove(), 600)
  }

  async loadCurrentModel(): Promise<void> {
    const manifest = this.models.find((m) => m.id === this.settings.modelId) ?? this.models[0]
    if (!manifest) {
      console.warn('[anime-companion] 未发现任何模型包。')
      return
    }
    await this.avatar.loadModel(manifest, manifest.id)
  }

  async applyTheme(): Promise<void> {
    const id = this.settings.themeId
    if (!id) {
      this.theme.setPack(null)
      this.theme.setMode(this.settings.themeMode as Mode)
      return
    }
    const meta = this.themes.find((t) => t.id === id)
    if (!meta) {
      this.theme.setPack(null)
      return
    }
    const css = await fetchThemeCss(id).catch(() => '')
    this.theme.setPack({
      id,
      name: meta.name,
      tokens: meta.tokens,
      css,
    })
    this.theme.setMode(this.settings.themeMode as Mode)
  }

  async update(patch: Partial<CompanionSettings>): Promise<void> {
    try {
      this.settings = await postSettings(patch)
    } catch (e) {
      this.settings = resolveSettings({ ...this.settings, ...patch })
      console.warn('[anime-companion] 保存设置失败，仅本地生效：', e)
    }
    this.applySettingsChange(patch)
    this.panelRoot?.onSettings?.(this.settings)
  }

  private applySettingsChange(patch: Partial<CompanionSettings>): void {
    if ('avatarVisible' in patch) this.avatar.setVisible(this.settings.avatarVisible)
    if ('avatarSize' in patch) this.avatar.setSize(this.settings.avatarSize)
    if ('themeId' in patch) void this.applyTheme()
    if ('themeMode' in patch) this.theme.setMode(this.settings.themeMode as Mode)
    if ('modelId' in patch) void this.loadCurrentModel()
    if ('ttsEnabled' in patch && !this.settings.ttsEnabled) this.queue?.stop()
    if ('speakMode' in patch && this.settings.speakMode === 'off') this.queue?.stop()
  }

  private mountToolbar(): void {
    const bar = document.createElement('div')
    bar.dataset.animeCompanion = 'toolbar'
    bar.style.cssText =
      'position:fixed;left:20px;bottom:20px;z-index:2147483001;display:flex;gap:8px;pointer-events:auto;'
    const mkBtn = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.style.cssText =
        'width:38px;height:38px;border-radius:50%;border:1px solid var(--dsw-alias-border, rgba(255,255,255,.15));' +
        'background:var(--dsw-alias-surface-2, rgba(30,30,40,.85));color:var(--dsw-alias-label, #eee);' +
        'font-size:16px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);backdrop-filter:blur(8px);'
      b.onclick = onClick
      return b
    }
    bar.appendChild(mkBtn('⚙', '动漫伴侣设置', () => this.togglePanel()))
    bar.appendChild(mkBtn('🙈', '显示/隐藏伴侣', () => void this.update({ avatarVisible: !this.settings.avatarVisible })))
    document.body.appendChild(bar)
    this.toolbarEl = bar
  }

  private togglePanel(): void {
    const existing = document.getElementById('anime-companion-panel')
    if (existing) {
      existing.remove()
      this.panelRoot = null
      return
    }
    const wrap = document.createElement('div')
    wrap.id = 'anime-companion-panel'
    document.body.appendChild(wrap)
    const root = createRoot(wrap)
    this.panelRoot = root
    root.render(createElement(SettingsPanel, { app: this }))
  }

  private tryHeaderSlot(): void {
    try {
      const slots = this.ctx?.slots
      const app = this
      const Btn = function ToggleButton() {
        const [on, setOn] = useState(app.settings.avatarVisible)
        return createElement(
          'button',
          {
            title: '动漫伴侣',
            onClick: () => {
              const next = !on
              setOn(next)
              void app.update({ avatarVisible: next })
            },
            style: { cursor: 'pointer' },
          },
          on ? '🙈' : '🎀',
        )
      }
      slots?.inject?.('conversation.session.header.utilities', () =>
        slots.register(
          { name: 'conversation.session.header.utilities', id: 'anime-companion-toggle', order: 91 },
          Btn,
        ),
      )
    } catch {
      /* 该 slot 名在当前版本不存在：浮动工具栏已提供入口 */
    }
  }
}

function Row(props: { label: string; children: ReactNode }) {
  return createElement(
    'label',
    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '10px 0', fontSize: 13 } },
    createElement('span', null, props.label),
    props.children,
  )
}

function SettingsPanel(props: { app: CompanionApp }) {
  const { app } = props
  const [s, setS] = useState<CompanionSettings>({ ...app.settings })
  const [voices] = useState<string[]>(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      return window.speechSynthesis.getVoices().filter((v) => /zh|chinese/i.test(v.lang + v.name)).map((v) => v.name)
    }
    return []
  })
  useEffect(() => {
    ;(app.panelRoot as any).onSettings = (next: CompanionSettings) => setS({ ...next })
    return () => {
      if (app.panelRoot) (app.panelRoot as any).onSettings = undefined
    }
  }, [app])

  const change = (patch: Partial<CompanionSettings>) => {
    setS((prev) => ({ ...prev, ...patch }))
    void app.update(patch)
  }
  const select = (value: string, onChange: (v: string) => void, opts: { value: string; label: string }[]) =>
    createElement(
      'select',
      { value, onChange: (e: any) => onChange(e.target.value), style: selectStyle },
      opts.map((o) => createElement('option', { key: o.value, value: o.value }, o.label)),
    )
  const slider = (value: number, min: number, max: number, step: number, onChange: (v: number) => void) =>
    createElement('input', {
      type: 'range', min, max, step, value,
      onChange: (e: any) => onChange(Number(e.target.value)),
      style: { width: 150 },
    })

  return createElement(
    'div',
    {
      style: {
        position: 'fixed', left: 20, bottom: 70, zIndex: 2147483002, width: 320,
        maxHeight: '72vh', overflowY: 'auto',
        background: 'var(--dsw-alias-surface-1, #1c1c26)',
        color: 'var(--dsw-alias-label, #eee)',
        border: '1px solid var(--dsw-alias-border, rgba(255,255,255,.12))',
        borderRadius: 14, padding: '14px 16px', boxShadow: '0 12px 40px rgba(0,0,0,.4)',
        backdropFilter: 'blur(12px)', fontSize: 13,
      },
    },
    createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
      createElement('b', { style: { fontSize: 15 } }, '🎀 动漫伴侣')),
    Row({ label: '伴侣开关', children: createElement('input', { type: 'checkbox', checked: s.enabled, onChange: (e: any) => change({ enabled: e.target.checked }) }) }),
    Row({ label: '显示形象', children: createElement('input', { type: 'checkbox', checked: s.avatarVisible, onChange: (e: any) => change({ avatarVisible: e.target.checked }) }) }),
    Row({
      label: '角色',
      children: select(s.modelId, (v) => change({ modelId: v }),
        app.models.map((m) => ({ value: m.id, label: m.name ?? m.id }))),
    }),
    Row({
      label: '主题',
      children: select(s.themeId, (v) => change({ themeId: v }),
        [{ value: '', label: '官方默认' }, ...app.themes.map((t) => ({ value: t.id, label: t.name ?? t.id }))]),
    }),
    Row({
      label: '外观',
      children: select(s.themeMode, (v) => change({ themeMode: v as Mode }),
        [{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' }]),
    }),
    createElement('hr', { style: { borderColor: 'rgba(255,255,255,.08)' } }),
    Row({ label: '语音朗读', children: createElement('input', { type: 'checkbox', checked: s.ttsEnabled, onChange: (e: any) => change({ ttsEnabled: e.target.checked }) }) }),
    Row({
      label: '朗读模式',
      children: select(s.speakMode, (v) => change({ speakMode: v as SpeakMode }),
        [{ value: 'off', label: '关闭' }, { value: 'final', label: '朗读最终回复' }, { value: 'manual', label: '仅手动' }]),
    }),
    Row({
      label: 'TTS 引擎',
      children: select(s.ttsEngine, (v) => change({ ttsEngine: v as TtsEnginePref }),
        [{ value: 'auto', label: '自动回退' }, { value: 'speechsynthesis', label: '浏览器内置' }, { value: 'edge', label: 'Edge TTS' }, { value: 'piper', label: 'Piper(离线)' }]),
    }),
    Row({
      label: '音色',
      children: voices.length
        ? select(s.voiceName, (v) => change({ voiceName: v }),
          [{ value: '', label: '默认' }, ...voices.map((v) => ({ value: v, label: v }))])
        : createElement('input', { value: s.voiceName, placeholder: 'Edge: zh-CN-XiaoxiaoNeural', onChange: (e: any) => change({ voiceName: e.target.value }), style: inputStyle }),
    }),
    Row({ label: `语速 ${s.rate.toFixed(2)}`, children: slider(s.rate, 0.5, 2, 0.05, (v) => change({ rate: v })) }),
    Row({ label: `音高 ${s.pitch.toFixed(2)}`, children: slider(s.pitch, 0, 2, 0.05, (v) => change({ pitch: v })) }),
    Row({ label: `音量 ${Math.round(s.volume * 100)}%`, children: slider(s.volume, 0, 1, 0.05, (v) => change({ volume: v })) }),
    Row({ label: '口型联动', children: createElement('input', { type: 'checkbox', checked: s.mouthSync, onChange: (e: any) => change({ mouthSync: e.target.checked }) }) }),
    Row({ label: '表情联动', children: createElement('input', { type: 'checkbox', checked: s.expressionLink, onChange: (e: any) => change({ expressionLink: e.target.checked }) }) }),
    Row({
      label: '朗读一遍',
      children: createElement('button', {
        style: btnStyle,
        onClick: () => app.queue?.enqueueMessage(`test-${Date.now()}`, '你好呀，我是你的动漫伴侣，很高兴见到你！', app.voiceOpts(), true),
      }, '▶ 试听'),
    }),
  )
}

const selectStyle: CSSProperties = {
  maxWidth: 170, background: 'rgba(255,255,255,.08)', color: 'inherit',
  border: '1px solid rgba(255,255,255,.15)', borderRadius: 8, padding: '4px 6px',
}
const inputStyle: CSSProperties = { ...selectStyle, width: 160 }
const btnStyle: CSSProperties = {
  background: 'var(--dsw-alias-brand, #7aa2ff)', color: '#fff', border: 'none',
  borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
}

export function apply(ctx: any): void {
  if (typeof window === 'undefined') return
  if ((window as any).__animeCompanionApp) return
  const app = new CompanionApp(ctx)
  ;(window as any).__animeCompanionApp = app
  app.start().catch((err) => {
    console.error('[anime-companion] 初始化失败：', err)
  })
}
