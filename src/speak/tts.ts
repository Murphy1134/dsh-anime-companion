/**
 * TTS 引擎回退链（SpeakPlayer 的实现）。
 * 顺序：浏览器 speechSynthesis → Edge TTS(host 代理) → Piper(host 代理)。
 * 任一失败打印原因并自动降级，绝不静默。Edge/Piper 经 AnalyserNode 算 RMS 驱动口型。
 */
import { apiUrl, resolveApiBase, ROUTES } from '../shared/protocol'
import type { SpeakPlayer, VoiceOpts } from './queue'

type EngineId = 'speechsynthesis' | 'edge' | 'piper'

interface TtsEngine {
  id: EngineId
  isAvailable(): Promise<boolean>
  speak(text: string, opts: VoiceOpts, onLevel: (l: number) => void, signal: AbortSignal): Promise<void>
}

class SpeechSynthesisEngine implements TtsEngine {
  id: EngineId = 'speechsynthesis'

  async isAvailable(): Promise<boolean> {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  speak(text: string, opts: VoiceOpts, onLevel: (l: number) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const synth = window.speechSynthesis
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'zh-CN'
      u.rate = opts.rate
      u.pitch = opts.pitch
      u.volume = opts.volume
      const voices = synth.getVoices?.() ?? []
      const v =
        (opts.voiceName && voices.find((x) => x.name === opts.voiceName)) ||
        voices.find((x) => x.lang?.toLowerCase().startsWith('zh'))
      if (v) u.voice = v

      let ticker: ReturnType<typeof setInterval> | null = null
      let phase = 0
      const stopTicker = () => {
        if (ticker) clearInterval(ticker)
        ticker = null
        onLevel(0)
      }
      const startTicker = () => {
        ticker = setInterval(() => {
          phase += 0.5
          const base = 0.55 + 0.35 * Math.sin(phase * 1.7) + 0.1 * Math.random()
          onLevel(Math.max(0, Math.min(1, base)))
        }, 90)
      }

      u.onstart = () => startTicker()
      u.onboundary = () => {
        onLevel(0.9)
      }
      u.onend = () => {
        stopTicker()
        resolve()
      }
      u.onerror = (e: any) => {
        stopTicker()
        if (signal.aborted || e?.error === 'canceled' || e?.error === 'interrupted') resolve()
        else reject(new Error(`speechSynthesis: ${e?.error ?? 'unknown'}`))
      }
      signal.addEventListener('abort', () => {
        stopTicker()
        try {
          synth.cancel()
        } catch {
          /* ignore */
        }
        resolve()
      }, { once: true })

      try {
        synth.speak(u)
      } catch (e) {
        stopTicker()
        reject(e instanceof Error ? e : new Error('speechSynthesis speak failed'))
      }
    })
  }
}

class HostAudioEngine implements TtsEngine {
  id: EngineId
  private audioCtx: AudioContext | null = null
  private activeSource: AudioBufferSourceNode | null = null

  constructor(id: EngineId) {
    this.id = id
  }

  async isAvailable(): Promise<boolean> {
    if (this.id === 'piper') {
      try {
        const u = await apiUrl('piper-voices')
        const r = await fetch(u, { credentials: 'same-origin' })
        if (!r.ok) return false
        const j = await r.json()
        return Array.isArray(j?.items) && j.items.length > 0
      } catch {
        return false
      }
    }
    return true
  }

  private ensureCtx(): AudioContext {
    if (!this.audioCtx) {
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
      this.audioCtx = new AC()
    }
    return this.audioCtx
  }

  async speak(text: string, opts: VoiceOpts, onLevel: (l: number) => void, signal: AbortSignal): Promise<void> {
    const url = await apiUrl(ROUTES.tts)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        engine: this.id,
        text,
        voice: opts.voiceName,
        rate: opts.rate,
        pitch: opts.pitch,
        volume: opts.volume,
      }),
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.json())?.error ?? ''
      } catch {
        /* ignore */
      }
      throw new Error(`${this.id}: HTTP ${res.status} ${detail}`)
    }
    const arrayBuf = await res.arrayBuffer()
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        /* 自动播放策略 */
      }
    }
    const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0))

    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    gain.gain.value = opts.volume
    source.buffer = audioBuf
    source.connect(analyser)
    analyser.connect(gain)
    gain.connect(ctx.destination)
    this.activeSource = source

    return new Promise<void>((resolve, reject) => {
      let raf = 0
      const data = new Uint8Array(analyser.fftSize)
      const sample = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const n = (data[i] - 128) / 128
          sum += n * n
        }
        const rms = Math.sqrt(sum / data.length)
        onLevel(Math.max(0, Math.min(1, rms * 3.2)))
        raf = requestAnimationFrame(sample)
      }
      const cleanup = () => {
        cancelAnimationFrame(raf)
        try {
          source.stop()
        } catch {
          /* ignore */
        }
        this.activeSource = null
        onLevel(0)
      }
      source.onended = () => {
        cancelAnimationFrame(raf)
        onLevel(0)
        this.activeSource = null
        resolve()
      }
      signal.addEventListener('abort', () => {
        cleanup()
        resolve()
      }, { once: true })
      try {
        source.start()
        raf = requestAnimationFrame(sample)
      } catch (e) {
        cancelAnimationFrame(raf)
        reject(e instanceof Error ? e : new Error(`${this.id} playback failed`))
      }
    })
  }

  cancelActive(): void {
    try {
      this.activeSource?.stop()
    } catch {
      /* ignore */
    }
    this.activeSource = null
  }
}

export class FallbackTts implements SpeakPlayer {
  private engines: Record<EngineId, TtsEngine> = {
    speechsynthesis: new SpeechSynthesisEngine(),
    edge: new HostAudioEngine('edge'),
    piper: new HostAudioEngine('piper'),
  }
  private availability = new Map<EngineId, boolean>()
  private currentAbort: AbortController | null = null

  constructor() {
    void resolveApiBase()
  }

  private order(pref: VoiceOpts['engine']): EngineId[] {
    if (pref === 'auto') return ['speechsynthesis', 'edge', 'piper']
    return [pref]
  }

  async speakSentence(sentence: string, opts: VoiceOpts, onLevel: (l: number) => void): Promise<void> {
    this.cancelAll()
    const ctrl = new AbortController()
    this.currentAbort = ctrl
    const chain = this.order(opts.engine)
    const errors: string[] = []
    for (const id of chain) {
      if (ctrl.signal.aborted) return
      const engine = this.engines[id]
      let available = this.availability.get(id)
      if (available === undefined) {
        try {
          available = await engine.isAvailable()
        } catch {
          available = false
        }
        this.availability.set(id, available)
      }
      if (!available) {
        console.warn(`[anime-companion][tts] 引擎 ${id} 不可用，降级。`)
        errors.push(`${id}=unavailable`)
        continue
      }
      try {
        console.info(`[anime-companion][tts] 使用引擎：${id}`)
        await engine.speak(sentence, opts, onLevel, ctrl.signal)
        if (!ctrl.signal.aborted) return
        return
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[anime-companion][tts] 引擎 ${id} 失败：${msg} → 降级。`)
        errors.push(`${id}=${msg}`)
        this.availability.set(id, false)
      }
    }
    onLevel(0)
    throw new Error(`所有 TTS 引擎均失败：${errors.join('; ')}`)
  }

  cancelAll(): void {
    this.currentAbort?.abort()
    this.currentAbort = null
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
    ;(this.engines.edge as HostAudioEngine).cancelActive()
    ;(this.engines.piper as HostAudioEngine).cancelActive()
  }
}
