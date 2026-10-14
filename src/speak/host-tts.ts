/**
 * Host 端 TTS 合成（回退链后两环）：Edge TTS（在线但不经大模型）→ Piper（离线）。
 * 失败必须抛带 code 的错误，绝不静默；客户端据此降级。
 * // TODO: 根据 DSH 当前版本/piper 版本确认采样率与协议字段。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface SynthesizeOptions {
  voice: string
  rate: number
  pitch: number
  volume: number
}

export interface SynthesizedAudio {
  contentType: 'audio/mpeg' | 'audio/wav'
  data: Buffer
}

export class TtsError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'TtsError'
    this.code = code
  }
}

const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_WSS_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
  `?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}`

function edgeRequestId(): string {
  return Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0'),
  )
    .join('')
    .toUpperCase()
}

function edgeTimestamp(): string {
  return new Date().toString()
}

function toPercent(v: number): string {
  const pct = Math.round((v - 1) * 100)
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export async function edgeSynthesize(
  text: string,
  opts: SynthesizeOptions,
): Promise<SynthesizedAudio> {
  const WS = (globalThis as any).WebSocket as typeof WebSocket | undefined
  if (!WS) {
    throw new TtsError('edge-no-websocket', '当前 Node 无全局 WebSocket，且未安装 ws，Edge TTS 不可用。')
  }
  if (!text.trim()) throw new TtsError('empty-text', '待合成文本为空。')

  const requestId = edgeRequestId()
  const audioChunks: Buffer[] = []

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      err ? reject(err) : resolve()
    }

    const ws = new WS(EDGE_WSS_URL)
    ws.binaryType = 'arraybuffer'
    const timeout = setTimeout(() => finish(new TtsError('edge-timeout', 'Edge TTS 响应超时。')), 20000)

    ws.onopen = () => {
      const config =
        `X-Timestamp:${edgeTimestamp()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        })
      ws.send(config)

      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name="${escapeXml(opts.voice || 'zh-CN-XiaoxiaoNeural')}">` +
        `<prosody pitch='${toPercent(opts.pitch)}' rate='${toPercent(opts.rate)}' ` +
        `volume='${Math.round(opts.volume * 100)}%'>${escapeXml(text)}</prosody>` +
        `</voice></speak>`
      const ssmlMsg =
        `X-RequestId:${requestId}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        `X-Timestamp:${edgeTimestamp()}\r\n` +
        'Path:ssml\r\n\r\n' +
        ssml
      ws.send(ssmlMsg)
    }

    ws.onmessage = (event: MessageEvent) => {
      const data = event.data
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          clearTimeout(timeout)
          finish()
        } else if (data.includes('Path:turn.response') || /Path:\w*[Ee]rror/.test(data)) {
          const m = data.match(/Path:(.*)/)
          if (/error/i.test(m?.[1] ?? '')) {
            clearTimeout(timeout)
            finish(new TtsError('edge-protocol', `Edge TTS 协议错误：${m?.[1] ?? 'unknown'}`))
          }
        }
        return
      }
      const buf = Buffer.from(data as ArrayBuffer)
      if (buf.length < 2) return
      const headerLen = buf.readUInt16BE(0)
      audioChunks.push(buf.subarray(2 + headerLen))
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      finish(new TtsError('edge-network', 'Edge TTS 网络连接失败（可能离线）。'))
    }
    ws.onclose = () => {
      clearTimeout(timeout)
      if (!settled) {
        if (audioChunks.length === 0) {
          finish(new TtsError('edge-empty', 'Edge TTS 未返回音频（音色名错误或被拒绝）。'))
        } else {
          finish()
        }
      }
    }
  })

  const mp3 = Buffer.concat(audioChunks)
  if (mp3.length === 0) throw new TtsError('edge-empty', 'Edge TTS 返回空音频。')
  return { contentType: 'audio/mpeg', data: mp3 }
}

export interface PiperConfig {
  bin: string
  voiceDir: string
}

export function listPiperVoices(voiceDir: string): string[] {
  if (!voiceDir || !existsSync(voiceDir)) return []
  try {
    return readdirSync(voiceDir)
      .filter((f) => f.endsWith('.onnx.json'))
      .map((f) => f.replace(/\.onnx\.json$/, ''))
  } catch {
    return []
  }
}

function wrapWav(pcm: Buffer, sampleRate = 22050): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function piperSynthesize(
  text: string,
  opts: SynthesizeOptions,
  cfg: PiperConfig,
): Promise<SynthesizedAudio> {
  return new Promise((resolve, reject) => {
    if (!cfg.bin || !existsSync(cfg.bin)) {
      reject(new TtsError('piper-no-bin', '未配置/找不到 piper 可执行文件。'))
      return
    }
    const voices = listPiperVoices(cfg.voiceDir)
    const voice = opts.voice && voices.includes(opts.voice) ? opts.voice : voices[0]
    if (!voice) {
      reject(new TtsError('piper-no-voice', `piper 音色目录下没有可用音色：${cfg.voiceDir}`))
      return
    }
    const modelPath = join(cfg.voiceDir, `${voice}.onnx`)
    const lengthScale = Math.max(0.5, Math.min(2, 1 / Math.max(opts.rate, 0.01)))
    const child = spawn(
      cfg.bin,
      ['--model', modelPath, '--output_raw', '--length_scale', String(lengthScale)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    child.on('error', (err) => reject(new TtsError('piper-spawn', `piper 启动失败：${err.message}`)))
    child.on('close', (code) => {
      const pcm = Buffer.concat(chunks)
      if (code !== 0 || pcm.length === 0) {
        reject(new TtsError('piper-run', `piper 合成失败（exit=${code}）：${stderr.slice(-300)}`))
        return
      }
      resolve({ contentType: 'audio/wav', data: wrapWav(pcm, 22050) })
    })
    child.stdin.write(text)
    child.stdin.end()
  })
}
