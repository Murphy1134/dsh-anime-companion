/**
 * 动漫伴侣形象层（右下角浮动）。
 * pixi-live2d-display 按需动态 import（缺 Cubism Core 不崩），PNG/SVG 兜底；
 * 可拖拽、可开关、口型由 TTS 电平驱动、状态表情联动、热重载切角色。
 */
import type { CompanionState } from '../capture/stream'
import { assetUrl } from '../shared/protocol'

interface Live2dDeps {
  PIXI: any
  Live2DModel: any
}
let live2dDepsCache: Live2dDeps | null | undefined
async function loadLive2dDeps(): Promise<Live2dDeps | null> {
  if (live2dDepsCache !== undefined) return live2dDepsCache
  if (!(window as any).Live2DCubismCore) {
    live2dDepsCache = null
    return null
  }
  try {
    const PIXI = await import('pixi.js')
    const mod = await import('pixi-live2d-display/cubism4')
    const Live2DModel = mod.Live2DModel ?? (mod.default && mod.default.Live2DModel)
    live2dDepsCache = { PIXI: PIXI.default ?? PIXI, Live2DModel }
    return live2dDepsCache
  } catch (e) {
    console.warn('[anime-companion] PIXI/Live2D 依赖加载失败：', e)
    live2dDepsCache = null
    return null
  }
}

export interface ModelManifest {
  id: string
  name?: string
  kind: 'live2d' | 'png'
  model?: string
  image?: string
  expressions?: Partial<Record<CompanionState, string>>
  expressionMap?: Partial<Record<CompanionState, string>>
  scale?: number
}

const HOST_ID = 'anime-companion-avatar'
const FALLBACK_EXPR: Record<CompanionState, string> = {
  idle: 'F00',
  thinking: 'F01',
  search: 'F01',
  generating: 'F00',
  done: 'F02',
  failed: 'F03',
}

interface Live2DHandle {
  app: any
  model: any
  ticker: any
}

export class AvatarManager {
  private host: HTMLDivElement | null = null
  private stage: HTMLDivElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private img: HTMLImageElement | null = null
  private handle: Live2DHandle | null = null
  private manifest: ModelManifest | null = null
  private size = 300
  private offsetX = 0
  private offsetY = 0
  private visible = true
  private state: CompanionState = 'idle'
  private targetMouth = 0
  private mouth = 0
  private raf = 0
  private disposed = false
  private onDragEnd?: (x: number, y: number) => void
  private pointerX = 0
  private pointerY = 0
  private drag = { active: false, startX: 0, startY: 0, baseX: 0, baseY: 0 }

  mount(parent: HTMLElement = document.body, onDragEnd?: (x: number, y: number) => void): void {
    if (this.host) return
    this.onDragEnd = onDragEnd
    const host = document.createElement('div')
    host.id = HOST_ID
    host.style.cssText = [
      'position:fixed', 'right:24px', 'bottom:104px', 'z-index:2147483000',
      'pointer-events:none', 'user-select:none', '-webkit-user-select:none',
      'transition:opacity .25s ease', 'will-change:transform',
    ].join(';')
    const stage = document.createElement('div')
    stage.style.cssText = [
      'position:relative', 'width:100%', 'height:100%',
      'pointer-events:auto', 'cursor:grab', 'touch-action:none',
    ].join(';')
    host.appendChild(stage)
    parent.appendChild(host)
    this.host = host
    this.stage = stage
    this.applyGeometry()
    this.attachDrag(stage)
    this.attachPointerTrack()
    this.startMouthLoop()
  }

  private applyGeometry(): void {
    if (!this.host) return
    this.host.style.width = `${this.size}px`
    this.host.style.height = `${this.size}px`
    this.host.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px)`
    this.host.style.display = this.visible ? 'block' : 'none'
  }

  setVisible(v: boolean): void {
    this.visible = v
    this.applyGeometry()
  }

  setSize(px: number): void {
    this.size = px
    this.applyGeometry()
    if (this.handle) this.fitModel()
    if (this.img) {
      this.img.style.width = `${this.size}px`
      this.img.style.height = `${this.size}px`
    }
  }

  setOffset(x: number, y: number): void {
    this.offsetX = x
    this.offsetY = y
    this.applyGeometry()
  }

  private attachDrag(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      this.drag = { active: true, startX: e.clientX, startY: e.clientY, baseX: this.offsetX, baseY: this.offsetY }
      el.setPointerCapture?.(e.pointerId)
      el.style.cursor = 'grabbing'
      e.preventDefault()
    })
    const move = (e: PointerEvent) => {
      if (!this.drag.active) return
      this.offsetX = this.drag.baseX + (e.clientX - this.drag.startX)
      this.offsetY = this.drag.baseY - (e.clientY - this.drag.startY)
      this.applyGeometry()
    }
    const up = (e: PointerEvent) => {
      if (!this.drag.active) return
      this.drag.active = false
      el.style.cursor = 'grab'
      el.releasePointerCapture?.(e.pointerId)
      this.onDragEnd?.(this.offsetX, this.offsetY)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  private attachPointerTrack(): void {
    window.addEventListener('pointermove', (e) => {
      this.pointerX = (e.clientX / window.innerWidth) * 2 - 1
      this.pointerY = (e.clientY / window.innerHeight) * 2 - 1
    })
  }

  async loadModel(manifest: ModelManifest, modelId: string): Promise<void> {
    this.manifest = manifest
    this.clearStage()
    if (manifest.kind === 'live2d') {
      if ((window as any).Live2DCubismCore) {
        try {
          const ok = await this.loadLive2d(manifest, modelId)
          if (ok) return
        } catch (e) {
          console.warn('[anime-companion] Live2D 加载失败，回退 PNG：', e)
        }
      } else {
        console.warn('[anime-companion] 未检测到 Live2DCubismCore，使用 PNG 兜底。')
      }
    }
    this.loadPng(manifest, modelId)
  }

  private loadPng(manifest: ModelManifest, modelId: string): void {
    if (!this.stage) return
    const img = document.createElement('img')
    img.draggable = false
    img.style.cssText = [
      'width:100%', 'height:100%', 'object-fit:contain',
      'pointer-events:none', '-webkit-user-drag:none',
    ].join(';')
    const src = assetUrl(`models/${modelId}/${manifest.image ?? 'avatar.png'}`)
    img.src = src
    img.onerror = () => console.warn('[anime-companion] PNG 形象加载失败：', src)
    this.stage.appendChild(img)
    this.img = img
  }

  private async loadLive2d(manifest: ModelManifest, modelId: string): Promise<boolean> {
    if (!this.stage) return false
    const deps = await loadLive2dDeps()
    if (!deps || !deps.Live2DModel) return false
    const { PIXI, Live2DModel } = deps
    Live2DModel.registerTicker(PIXI.Ticker)
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:100%;height:100%;pointer-events:none;'
    this.stage.appendChild(canvas)
    this.canvas = canvas
    const app = new PIXI.Application({
      view: canvas,
      width: this.size,
      height: this.size,
      transparent: true,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      autoStart: true,
    })
    const modelUrl = assetUrl(`models/${modelId}/${manifest.model}`)
    const model = await Live2DModel.from(modelUrl, { autoInteract: false })
    app.stage.addChild(model)
    this.handle = { app, model, ticker: null }
    this.fitModel()
    this.applyExpression()
    const ticker = () => {
      const cm = model.internalModel?.coreModel
      if (cm) {
        try {
          cm.setParameterValueById?.('ParamAngleX', this.pointerX * 12, 0.4)
          cm.setParameterValueById?.('ParamAngleY', this.pointerY * 8, 0.4)
          this.mouth += (this.targetMouth - this.mouth) * 0.35
          cm.setParameterValueById?.('ParamMouthOpenY', this.mouth)
        } catch {
          /* 该模型可能没有对应参数 */
        }
      }
    }
    app.ticker.add(ticker)
    this.handle.ticker = ticker
    return true
  }

  private fitModel(): void {
    const { model, app } = this.handle ?? {}
    if (!model || !app) return
    const extra = (this.manifest?.scale ?? 1)
    const scale = Math.min(this.size / model.width, this.size / model.height) * 0.92 * extra
    model.scale.set(scale)
    model.anchor?.set?.(0.5, 0.5)
    model.position.set(this.size / 2, this.size / 2)
  }

  private clearStage(): void {
    if (this.handle) {
      try {
        this.handle.ticker && this.handle.app.ticker.remove(this.handle.ticker)
        this.handle.model.destroy?.({ children: true })
        this.handle.app.destroy?.(true, { children: true })
      } catch {
        /* ignore */
      }
      this.handle = null
    }
    this.canvas?.remove()
    this.img?.remove()
    this.canvas = null
    this.img = null
  }

  setState(state: CompanionState): void {
    this.state = state
    this.applyExpression()
  }

  private applyExpression(): void {
    if (this.handle?.model) {
      const name = this.manifest?.expressionMap?.[this.state] || FALLBACK_EXPR[this.state]
      try {
        this.handle.model.expression(name)
      } catch {
        /* 模型缺少该表情 */
      }
    } else if (this.img && this.manifest) {
      const rel = this.manifest.expressions?.[this.state]
      if (rel) this.img.src = assetUrl(`models/${this.manifest.id}/${rel}`)
    }
  }

  setMouth(level: number): void {
    this.targetMouth = Math.max(0, Math.min(1, level))
  }

  private startMouthLoop(): void {
    const loop = () => {
      if (this.disposed) return
      this.mouth += (this.targetMouth - this.mouth) * 0.35
      if (this.img && !this.canvas) {
        const s = 1 + this.mouth * 0.025
        this.img.style.transform = `scaleY(${s.toFixed(3)})`
        this.img.style.transformOrigin = 'bottom center'
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.clearStage()
    this.host?.remove()
    this.host = null
    this.stage = null
  }
}
