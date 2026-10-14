/**
 * Host / Client 两半共享的协议常量，以及浏览器侧的“绝对 API 基址探测”。
 * Electron 自定义协议下根相对路径会 404，故启动时并发探测候选前缀并缓存。
 */

export const PLUGIN_ID = 'dsh-anime-companion'

export const API_PREFIX = '/api/anime-companion'

export const ASSETS_PREFIX = `${API_PREFIX}/assets`

export const ROUTES = {
  skin: `${API_PREFIX}/skin.json`,
  settings: `${API_PREFIX}/settings`,
  models: `${API_PREFIX}/models`,
  themes: `${API_PREFIX}/themes`,
  tts: `${API_PREFIX}/tts/synthesize`,
} as const

const PROBE_PATH = `${API_PREFIX}/skin.json`

function candidateBases(): string[] {
  const out: string[] = []
  const push = (u: string) => {
    if (u && !out.includes(u)) out.push(u)
  }
  if (typeof window !== 'undefined') {
    const injected = (window as any).__ANIME_COMPANION__?.apiBase
    if (injected) push(injected)
    const { protocol, origin } = window.location
    if (protocol === 'http:' || protocol === 'https:') {
      push(`${origin}${API_PREFIX}`)
    } else {
      push(`${origin}/app${API_PREFIX}`)
      push(`${origin}${API_PREFIX}`)
      const envBase = (window as any).__DSH_WEB_URL__ as string | undefined
      if (envBase) push(`${envBase.replace(/\/$/, '')}${API_PREFIX}`)
    }
    push(API_PREFIX)
  }
  return out
}

function probe(base: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `${base.replace(/\/$/, '')}/skin.json`
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      ctrl.abort()
      resolve(false)
    }, timeoutMs)
    fetch(url, { method: 'GET', signal: ctrl.signal, credentials: 'same-origin' })
      .then((r) => {
        clearTimeout(timer)
        resolve(r.ok)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(false)
      })
  })
}

let cachedBase: string | null = null
let probing: Promise<string> | null = null

export function getCachedApiBase(): string {
  return cachedBase ?? API_PREFIX
}

export function resolveApiBase(timeoutMs = 2500): Promise<string> {
  if (cachedBase) return Promise.resolve(cachedBase)
  if (probing) return probing
  probing = (async () => {
    const candidates = candidateBases()
    for (let i = 0; i < candidates.length; i++) {
      const base = candidates[i]
      const batch = [base, candidates[i + 1]].filter(Boolean) as string[]
      const winner = await Promise.any(
        batch.map(async (b) => ((await probe(b, timeoutMs)) ? b : Promise.reject(new Error('miss')))),
      ).catch(() => null)
      if (winner) {
        cachedBase = winner
        i++
        console.info(`[anime-companion] API base → ${winner}`)
        return winner
      }
    }
    cachedBase = API_PREFIX
    console.warn('[anime-companion] 未探测到可用 API 基址，退化为根相对路径。')
    return cachedBase
  })()
  return probing
}

export async function apiUrl(path: string): Promise<string> {
  const base = await resolveApiBase()
  if (/^https?:\/\//.test(path) || /^[a-z][a-z0-9+.-]*:\/\//.test(path)) return path
  const normalized = path.startsWith(API_PREFIX) ? path : `${API_PREFIX}/${path.replace(/^\//, '')}`
  if (base.includes('://')) {
    const root = base.replace(/\/$/, '')
    const tail = normalized.startsWith(API_PREFIX) ? normalized.slice(API_PREFIX.length) : normalized
    return `${root}${tail}`
  }
  return normalized
}

export function assetUrl(rel: string): string {
  const base = getCachedApiBase()
  const clean = rel.replace(/^\/+/, '')
  if (base.includes('://')) return `${base.replace(/\/$/, '')}/assets/${clean}`
  return `${ASSETS_PREFIX}/${clean}`
}
