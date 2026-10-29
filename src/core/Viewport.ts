/**
 * 视口与尺寸：统一管理 canvas 尺寸、DPR 上限、自适应降级。
 *
 * 设计要点：
 * - 尺寸变化走 ResizeObserver + rAF 合并，避免拖窗口时每帧重建 render target；
 * - DPR 上限由画质档位决定，而不是直接用 devicePixelRatio；
 * - 提供「动态分辨率」开关：连续掉帧时自动降像素比，是真实项目里的常规手段。
 */
export interface ViewportMetrics {
  width: number;
  height: number;
  pixelRatio: number;
  aspect: number;
}

export interface ViewportOptions {
  canvas: HTMLCanvasElement;
  maxPixelRatio: number;
  /** 允许在掉帧时自动降分辨率 */
  adaptive: boolean;
}

type Listener = (metrics: ViewportMetrics) => void;

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  private readonly listeners = new Set<Listener>();
  private readonly resizeObserver: ResizeObserver;

  private metrics: ViewportMetrics;
  private maxPixelRatio: number;
  private adaptive: boolean;
  private basePixelRatio: number;
  private pendingFrame = 0;
  private disposed = false;

  constructor(opts: ViewportOptions) {
    this.canvas = opts.canvas;
    this.maxPixelRatio = opts.maxPixelRatio;
    this.adaptive = opts.adaptive;
    this.basePixelRatio = this.computePixelRatio();
    this.metrics = this.measure();

    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(this.canvas, { box: 'content-box' });
    window.addEventListener('orientationchange', this.schedule);
  }

  get current(): ViewportMetrics {
    return this.metrics;
  }

  get ratio(): number {
    return this.metrics.pixelRatio;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setMaxPixelRatio(value: number): void {
    this.maxPixelRatio = value;
    this.basePixelRatio = this.computePixelRatio();
    this.apply(this.basePixelRatio);
  }

  /**
   * 动态分辨率：ratio ∈ [0.6, base]。用于掉帧时保帧率。
   */
  setPixelRatioScale(scale: number): void {
    if (!this.adaptive) return;
    const target = Math.max(0.6, Math.min(1, scale)) * this.basePixelRatio;
    if (Math.abs(target - this.metrics.pixelRatio) < 0.02) return;
    this.apply(target);
  }

  enableAdaptive(enable: boolean): void {
    this.adaptive = enable;
  }

  /** 强制刷新，用于初始化时同步一次 */
  flush(): void {
    this.apply(this.basePixelRatio);
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    window.removeEventListener('orientationchange', this.schedule);
    if (this.pendingFrame) cancelAnimationFrame(this.pendingFrame);
    this.listeners.clear();
  }

  private readonly schedule = (): void => {
    if (this.disposed || this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = 0;
      this.basePixelRatio = this.computePixelRatio();
      this.apply(this.basePixelRatio);
    });
  };

  private computePixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(dpr, this.maxPixelRatio);
  }

  private measure(pixelRatio = this.metrics?.pixelRatio ?? this.computePixelRatio()): ViewportMetrics {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width) || window.innerWidth);
    const height = Math.max(1, Math.round(rect.height) || window.innerHeight);
    return { width, height, pixelRatio, aspect: width / height };
  }

  private apply(pixelRatio: number): void {
    const next = this.measure(pixelRatio);
    const prev = this.metrics;
    if (
      prev &&
      prev.width === next.width &&
      prev.height === next.height &&
      Math.abs(prev.pixelRatio - next.pixelRatio) < 0.001
    ) {
      return;
    }
    this.metrics = next;
    for (const fn of this.listeners) fn(next);
  }
}
