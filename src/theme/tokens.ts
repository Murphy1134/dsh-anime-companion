/**
 * 主题 token 覆盖（换肤）。
 * 注入专属 <style>，把 light/dark 两套 --dsw-alias-* 语义 token 写在
 * html[data-anime-theme] 作用域；按签名去重防 theme/change 重入。
 * // TODO: 根据 DSH 当前版本适配 API（ThemeRuntime 注册方法名）。
 */

export type Mode = 'light' | 'dark' | 'system'

export type TokenMap = Record<string, string>

export interface ThemePack {
  id: string
  name?: string
  css?: string
  cssUrl?: string
  tokens?: {
    light?: TokenMap
    dark?: TokenMap
  }
}

const STYLE_ID = 'anime-companion-theme'
const LINK_ID = 'anime-companion-theme-link'
const ATTR = 'data-anime-theme'

function decls(tokens: TokenMap | undefined): string {
  if (!tokens) return ''
  return Object.entries(tokens)
    .map(([k, v]) => `  ${k.startsWith('--') ? k : `--dsw-alias-${k}`}: ${v};`)
    .join('\n')
}

export function detectDarkMode(): boolean {
  if (typeof document === 'undefined') return false
  if (document.body?.hasAttribute('data-ds-dark-theme')) return true
  if (document.documentElement?.hasAttribute('data-ds-dark-theme')) return true
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
}

function signature(pack: ThemePack | null, mode: 'light' | 'dark'): string {
  return JSON.stringify({
    id: pack?.id ?? '',
    mode,
    light: pack?.tokens?.light ?? {},
    dark: pack?.tokens?.dark ?? {},
    css: pack?.css ?? '',
    cssUrl: pack?.cssUrl ?? '',
  })
}

export class ThemeManager {
  private pack: ThemePack | null = null
  private mode: Mode = 'system'
  private lastSignature = ''
  private observer: MutationObserver | null = null
  private media: MediaQueryList | null = null
  private disposed = false
  private themeUnregister: (() => void) | null = null

  attach(ctx?: any): void {
    this.tryOfficialTheme(ctx)
    this.observer = new MutationObserver(() => this.refresh())
    this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
    if (document.body) {
      this.observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
    }
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.media = window.matchMedia('(prefers-color-scheme: dark)')
      this.media.addEventListener?.('change', this.refresh)
    }
  }

  private tryOfficialTheme(ctx: any): void {
    try {
      const theme = ctx?.get?.('theme') ?? ctx?.theme
      if (!theme) return
      const fn = theme.registerTheme ?? theme.overrideTokens ?? theme.addTheme
      if (typeof fn === 'function' && this.pack) {
        const ret = fn.call(theme, {
          id: this.pack.id,
          name: this.pack.name,
          light: this.pack.tokens?.light ?? {},
          dark: this.pack.tokens?.dark ?? {},
        })
        if (typeof ret === 'function') this.themeUnregister = ret
      }
    } catch {
      /* 官方接口不可用：CSS 注入路径仍生效 */
    }
  }

  setPack(pack: ThemePack | null): void {
    this.pack = pack
    this.tryOfficialTheme({})
    this.render(true)
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.render(true)
  }

  effectiveMode(): 'light' | 'dark' {
    if (this.mode === 'system') return detectDarkMode() ? 'dark' : 'light'
    return this.mode
  }

  private refresh = (): void => {
    if (this.disposed) return
    this.render(false)
  }

  private render(force: boolean): void {
    if (typeof document === 'undefined') return
    const mode = this.effectiveMode()
    const sig = signature(this.pack, mode)
    if (!force && sig === this.lastSignature) return
    this.lastSignature = sig
    document.documentElement.setAttribute(ATTR, mode)

    let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = STYLE_ID
      styleEl.dataset.animeCompanion = 'theme'
      document.head.appendChild(styleEl)
    }
    const light = this.pack?.tokens?.light ?? {}
    const dark = this.pack?.tokens?.dark ?? {}
    const extraCss = this.pack?.css ?? ''
    styleEl.textContent =
      `html[${ATTR}='light'] {\n${decls(light)}\n}\n` +
      `html[${ATTR}='dark'] {\n${decls(dark)}\n}\n` +
      extraCss
    this.applyLink(this.pack?.cssUrl)
  }

  private applyLink(href?: string): void {
    let link = document.getElementById(LINK_ID) as HTMLLinkElement | null
    if (!href) {
      link?.remove()
      return
    }
    if (!link) {
      link = document.createElement('link')
      link.id = LINK_ID
      link.rel = 'stylesheet'
      link.dataset.animeCompanion = 'theme-link'
      document.head.appendChild(link)
    }
    if (link.href !== href) link.href = href
  }

  dispose(): void {
    this.disposed = true
    this.observer?.disconnect()
    this.media?.removeEventListener?.('change', this.refresh)
    this.themeUnregister?.()
    document.getElementById(STYLE_ID)?.remove()
    document.getElementById(LINK_ID)?.remove()
    document.documentElement.removeAttribute(ATTR)
  }
}
