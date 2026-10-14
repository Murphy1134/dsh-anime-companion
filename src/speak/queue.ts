/**
 * 朗读队列：把最终回复清洗、按句切分，串行喂给 TTS 引擎；口型电平回传。
 */

export interface VoiceOpts {
  voiceName: string
  engine: 'auto' | 'speechsynthesis' | 'edge' | 'piper'
  rate: number
  pitch: number
  volume: number
}

export interface SpeakPlayer {
  speakSentence(sentence: string, opts: VoiceOpts, onLevel: (level: number) => void): Promise<void>
  cancelAll(): void
}

const MAX_SENTENCE = 160
const MAX_QUEUE = 400

export function cleanForSpeech(raw: string): string {
  let t = raw
  t = t.replace(/```[\s\S]*?```/g, '（代码片段）')
  t = t.replace(/`([^`]*)`/g, '$1')
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  t = t.replace(/^\s{0,3}>\s?/gm, '')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  t = t.replace(/^\s*\d+\.\s+/gm, '')
  t = t.replace(/(\*\*|__|~~|\*|_)/g, '')
  t = t.replace(/\|/g, '，')
  t = t.replace(/https?:\/\/\S+/g, '')
  t = t.replace(/<\/?[a-z][^>]*>/gi, '')
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  return t
}

export function splitSentences(raw: string): string[] {
  const text = cleanForSpeech(raw)
  if (!text) return []
  const rough: string[] = []
  let buf = ''
  const flush = () => {
    const s = buf.trim()
    if (s) rough.push(s)
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1] ?? ''
    buf += ch
    if ('。！？；…\n'.includes(ch)) {
      flush()
    } else if ('.!?;'.includes(ch)) {
      if (/\s/.test(next) || next === '') flush()
    }
  }
  flush()
  const out: string[] = []
  for (const seg of rough) {
    if (seg.length <= MAX_SENTENCE) {
      out.push(seg)
      continue
    }
    let part = ''
    for (let i = 0; i < seg.length; i++) {
      part += seg[i]
      if ((',，、：:—'.includes(seg[i]) && part.length >= MAX_SENTENCE * 0.5) || part.length >= MAX_SENTENCE) {
        const p = part.trim()
        if (p) out.push(p)
        part = ''
      }
    }
    if (part.trim()) out.push(part.trim())
  }
  return out.map((s) => s.trim()).filter(Boolean)
}

interface QueueItem {
  sentence: string
  opts: VoiceOpts
}

export class SpeakQueue {
  private player: SpeakPlayer
  private queue: QueueItem[] = []
  private running = false
  private stopped = false
  private spokenMessages = new Set<string>()
  private activeMessageId: string | null = null
  private onLevel: (level: number) => void
  private onState?: (speaking: boolean) => void

  constructor(player: SpeakPlayer, onLevel: (level: number) => void, onState?: (speaking: boolean) => void) {
    this.player = player
    this.onLevel = onLevel
    this.onState = onState
  }

  get isSpeaking(): boolean {
    return this.running
  }

  hasSpoken(messageId: string): boolean {
    return this.spokenMessages.has(messageId)
  }

  enqueueMessage(messageId: string, text: string, opts: VoiceOpts, allowReplay = false): number {
    if (!allowReplay && this.spokenMessages.has(messageId)) return 0
    this.spokenMessages.add(messageId)
    const sentences = splitSentences(text)
    if (sentences.length === 0) return 0
    for (const s of sentences) this.queue.push({ sentence: s, opts })
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
    void this.drain()
    return sentences.length
  }

  stop(): void {
    this.stopped = true
    this.queue = []
    this.activeMessageId = null
    try {
      this.player.cancelAll()
    } catch {
      /* ignore */
    }
    this.setRunning(false)
  }

  resetHistory(): void {
    this.spokenMessages.clear()
  }

  private setRunning(v: boolean): void {
    if (this.running === v) return
    this.running = v
    this.onState?.(v)
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.stopped = false
    this.setRunning(true)
    while (this.queue.length > 0) {
      if (this.stopped) break
      const item = this.queue.shift()
      if (!item) break
      try {
        if (this.stopped) break
        await this.player.speakSentence(item.sentence, item.opts, (l) => {
          if (!this.stopped) this.onLevel(l)
        })
      } catch (e) {
        console.warn('[anime-companion] 朗读单句失败：', e)
      }
    }
    this.onLevel(0)
    this.setRunning(false)
  }
}
