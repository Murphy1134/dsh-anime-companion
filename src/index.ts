/**
 * dsh-anime-companion —— Host 半（Node 端）。
 * 注册 settings owner scope、prefix 路由族、tapIndex 注入引导/启动动画/可选 Cubism Core。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  existsSync, readFileSync, readdirSync, statSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_PREFIX } from './shared/protocol'
import {
  ENTRY_ID, SETTINGS_NAMESPACE, pickKnown, resolveSettings,
  validateSettings, type CompanionSettings,
} from './shared/settings'
import { edgeSynthesize, listPiperVoices, piperSynthesize, TtsError } from './speak/host-tts'

export const name = 'dsh-anime-companion'
export const inject = ['settings', 'webServer']

export interface CompanionConfig {
  enabled?: boolean
  legacySettings?: boolean | null
  piperBin?: string
  piperVoiceDir?: string
}

const enumField = (values: readonly string[]) =>
  Schema.union(values.map((v) => Schema.const(v)))

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  avatarVisible: Schema.boolean().default(true).volatile(),
  avatarSize: Schema.number().default(300).min(120).max(640).step(1).volatile(),
  avatarOffsetX: Schema.number().default(0).min(-4000).max(4000).volatile(),
  avatarOffsetY: Schema.number().default(0).min(-4000).max(4000).volatile(),
  themeId: Schema.string().default('example').volatile(),
  themeMode: enumField(['light', 'dark', 'system']).default('system').volatile(),
  modelId: Schema.string().default('example').volatile(),
  ttsEnabled: Schema.boolean().default(true).volatile(),
  ttsEngine: enumField(['auto', 'speechsynthesis', 'edge', 'piper']).default('auto').volatile(),
  speakMode: enumField(['off', 'final', 'manual']).default('final').volatile(),
  voiceName: Schema.string().default('').volatile(),
  rate: Schema.number().default(1).min(0.5).max(2).step(0.05).volatile(),
  pitch: Schema.number().default(1).min(0).max(2).step(0.05).volatile(),
  volume: Schema.number().default(1).min(0).max(1).step(0.05).volatile(),
  mouthSync: Schema.boolean().default(true).volatile(),
  expressionLink: Schema.boolean().default(true).volatile(),
  splash: Schema.boolean().default(true).volatile(),
  legacySettings: Schema.union([Schema.boolean(), Schema.const(null)]).default(null),
  piperBin: Schema.string().default(''),
  piperVoiceDir: Schema.string().default(''),
})

export function packageRoot(importMetaUrl: string): string {
  return fileURLToPath(new URL('../', importMetaUrl))
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendBytes(res: ServerResponse, data: Buffer, contentType: string, extra?: Record<string, string>): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(data.length),
    ...(extra ?? {}),
  })
  res.end(data)
}

function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      parts.push(c)
      size += c.length
      if (size > limit) {
        tooLarge = true
        req.pause()
        reject(new Error('body-too-large'))
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        const txt = Buffer.concat(parts).toString('utf8')
        resolve(txt === '' ? {} : (JSON.parse(txt) as Record<string, unknown>))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
function bareHost(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  const colon = host.indexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}
function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host || !LOOPBACK.has(bareHost(host))) return false
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = req.headers.origin
  if (origin && origin !== 'null') {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  return true
}

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.moc3': 'application/octet-stream',
}

function resolveAsset(root: string, bucket: string, rel: string): string | null {
  const baseDir =
    bucket === 'models' ? join(root, 'models')
      : bucket === 'themes' ? join(root, 'themes')
        : bucket === 'vendor' ? join(root, 'vendor')
          : null
  if (!baseDir) return null
  const target = normalize(join(baseDir, rel))
  if (target !== baseDir && !target.startsWith(baseDir + sep)) return null
  return target
}

function readManifests(root: string, bucket: 'models' | 'themes', file: string): unknown[] {
  const dir = join(root, bucket)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = join(dir, d.name, file)
      if (!existsSync(p)) return null
      try {
        return { id: d.name, ...(JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

interface SettingsFace {
  describe(): readonly { ns: string; value?: unknown }[]
  replace(ns: string, section: object): Promise<void>
  register?(ns: string, schema: unknown, options?: { applies: string }): unknown
  configure?(presentation: { auto?: boolean }, owner?: unknown): () => void
}

function readSection(settings: SettingsFace, ns: string): CompanionSettings {
  const value = settings.describe().find((d) => d.ns === ns)?.value
  return resolveSettings(value as Partial<CompanionSettings> | undefined)
}

function splashCss(loadingText: string[]): string {
  const lines = loadingText.length ? loadingText : ['正在加载…']
  const texts = lines.map((t) => JSON.stringify(t)).join(',')
  return `
<style id="anime-companion-splash">
#anime-companion-boot{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;
align-items:center;justify-content:center;gap:18px;
background:radial-gradient(1200px 600px at 50% 30%, rgba(120,120,160,.18), transparent 60%),
var(--dsw-alias-bg-body, #0d0d12);transition:opacity .45s ease;}
#anime-companion-boot.hide{opacity:0;pointer-events:none;}
.anime-boot-ring{width:56px;height:56px;border-radius:50%;
border:3px solid rgba(255,255,255,.12);border-top-color:var(--dsw-alias-brand, #7aa2ff);
animation:anime-spin 1s linear infinite;}
@keyframes anime-spin{to{transform:rotate(360deg);}}
#anime-companion-boot .anime-boot-text{font-size:14px;color:var(--dsw-alias-label-secondary, #aab);
min-height:20px;animation:anime-blink 1.6s ease-in-out infinite;}
@keyframes anime-blink{0%,100%{opacity:.55}50%{opacity:1}}
</style>
<div id="anime-companion-boot"><div class="anime-boot-ring"></div>
<div class="anime-boot-text"></div></div>
<script>
(function(){var texts=${texts};var i=0;var el=document.querySelector('#anime-companion-boot .anime-boot-text');
if(el){el.textContent=texts[0];setInterval(function(){if(document.getElementById('anime-companion-boot')){
i=(i+1)%texts.length;el.textContent=texts[i];}},1600);}})();
</script>`
}

export function apply(ctx: Context, config: CompanionConfig = {}): void {
  const root = packageRoot(import.meta.url)
  const mainFiber = (ctx as any).fiber
  let skin: { boot?: { splash?: boolean; loadingText?: string[] } } = {}
  try {
    skin = JSON.parse(readFileSync(join(root, 'skin.json'), 'utf8'))
  } catch {
    /* skin.json 缺失时用默认 */
  }

  ctx.inject(['settings', 'webServer'], (hostCtx) => {
    const settings = hostCtx.settings as unknown as SettingsFace
    const useLegacy =
      config.legacySettings === true ? true : typeof settings.register === 'function'
    const ns = useLegacy ? SETTINGS_NAMESPACE : ENTRY_ID

    if (useLegacy) {
      const already = settings.describe().some((d) => d.ns === ns)
      if (!already) {
        try {
          settings.register?.(ns, { type: 'object' }, { applies: 'live' })
        } catch (e) {
          console.warn('[anime-companion] settings.register 失败：', e)
        }
      }
    } else if (typeof settings.configure === 'function') {
      hostCtx.effect(() => {
        const dispose = settings.configure?.({ auto: false }, mainFiber)
        return () => dispose?.()
      }, 'anime-companion: settings configure')
    }

    const route: WebRoute = {
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const pathname = new URL(req.url ?? '/', 'http://local').pathname
          const rel = pathname.slice(API_PREFIX.length)
          const body = () => readJsonBody(req)

          switch (true) {
            case rel === '/skin.json': {
              if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method' })
              const data = await readFile(join(root, 'skin.json'))
              return sendBytes(res, data, 'application/json; charset=utf-8')
            }
            case rel === '/settings': {
              if (req.method === 'GET') {
                return json(res, 200, { ok: true, value: readSection(settings, ns) })
              }
              if (req.method === 'POST') {
                if (!isLocalRequest(req)) return json(res, 403, { ok: false, error: 'cross-site' })
                const b = await body()
                const err = validateSettings(b)
                if (err) return json(res, 400, { ok: false, error: err })
                const merged = { ...pickKnown(readSection(settings, ns) as unknown as Record<string, unknown>), ...pickKnown(b) }
                await settings.replace(ns, merged)
                return json(res, 200, { ok: true, value: readSection(settings, ns) })
              }
              return json(res, 405, { ok: false, error: 'method' })
            }
            case rel === '/models': {
              if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method' })
              return json(res, 200, { ok: true, items: readManifests(root, 'models', 'manifest.json') })
            }
            case rel === '/themes': {
              if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method' })
              return json(res, 200, { ok: true, items: readManifests(root, 'themes', 'theme.json') })
            }
            case rel === '/piper-voices': {
              if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method' })
              return json(res, 200, { ok: true, items: listPiperVoices(config.piperVoiceDir ?? '') })
            }
            case rel === '/tts/synthesize': {
              if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' })
              if (!isLocalRequest(req)) return json(res, 403, { ok: false, error: 'cross-site' })
              const b = await body()
              const engine = String(b.engine ?? 'edge')
              const text = String(b.text ?? '')
              const opts = {
                voice: String(b.voice ?? ''),
                rate: Number(b.rate ?? 1),
                pitch: Number(b.pitch ?? 1),
                volume: Number(b.volume ?? 1),
              }
              try {
                const audio = engine === 'piper'
                  ? await piperSynthesize(text, opts, { bin: config.piperBin ?? '', voiceDir: config.piperVoiceDir ?? '' })
                  : await edgeSynthesize(text, opts)
                return sendBytes(res, audio.data, audio.contentType, { 'cache-control': 'no-store' })
              } catch (e) {
                const code = e instanceof TtsError ? e.code : 'tts-failed'
                const msg = e instanceof Error ? e.message : String(e)
                return json(res, 502, { ok: false, error: code, message: msg })
              }
            }
            case rel.startsWith('/assets/'): {
              if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method' })
              const rest = decodeURIComponent(rel.slice('/assets/'.length))
              const slash = rest.indexOf('/')
              const bucket = rest.slice(0, slash)
              const fileRel = rest.slice(slash + 1)
              const target = resolveAsset(root, bucket, fileRel)
              if (!target || !existsSync(target) || !statSync(target).isFile()) {
                return json(res, 404, { ok: false, error: 'not-found' })
              }
              const data = await readFile(target)
              const ext = extname(target).toLowerCase()
              const mime = MIME[ext] ?? 'application/octet-stream'
              const headers = {
                'cache-control': 'public, max-age=31536000, immutable',
                'x-content-type-options': 'nosniff',
              }
              if (req.method === 'HEAD') {
                res.writeHead(200, { 'content-type': mime, 'content-length': String(data.length), ...headers })
                res.end()
                return
              }
              return sendBytes(res, data, mime, headers)
            }
            default:
              return json(res, 404, { ok: false, error: 'not-found' })
          }
        } catch (e) {
          const msg = e instanceof Error ? (e.message === 'body-too-large' ? 'body-too-large' : e.message) : String(e)
          return json(res, 400, { ok: false, error: msg })
        }
      },
    }
    hostCtx.effect(() => hostCtx.webServer.register(route), 'anime-companion: api route')

    hostCtx.effect(() => {
      const dispose = hostCtx.webServer.tapIndex((html: string) => {
        const cubismVendor = join(root, 'vendor', 'live2dcubismcore.min.js')
        const cubismTag = existsSync(cubismVendor)
          ? `<script src="${API_PREFIX}/assets/vendor/live2dcubismcore.min.js"></script>`
          : ''
        const boot = {
          splash: skin.boot?.splash ?? true,
          loadingText: skin.boot?.loadingText ?? [],
        }
        const bootstrap =
          `<script>window.__ANIME_COMPANION__=${JSON.stringify({ boot, cubismCore: cubismTag ? 'vendor' : null })};</script>`
        const splash = boot.splash ? splashCss(boot.loadingText) : ''
        let out = html
        out = out.replace(/<head[^>]*>/i, (m) => m + bootstrap + cubismTag)
        if (splash) out = out.replace(/<body[^>]*>/i, (m) => m + splash)
        return out
      })
      return () => dispose
    }, 'anime-companion: index taps')
  })
}

export default { name, apply, inject, Config }
