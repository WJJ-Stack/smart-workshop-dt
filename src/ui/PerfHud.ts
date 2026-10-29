import type { LoopStats } from '../core/Loop';
import type { RendererInfoSnapshot } from '../core/Renderer';

/**
 * 性能 HUD：JD 里"能做性能排查、能讲清实现方式"的直接证据。
 * 显示 FPS / 帧耗时 p95 / drawcall / 三角面 / 纹理显存，并按帧率自动着色。
 */
export interface HudData {
  loop: LoopStats;
  renderer: RendererInfoSnapshot;
  tier: string;
  extra?: Record<string, string>;
}

export class PerfHud {
  readonly el: HTMLDivElement;
  private readonly rows = new Map<string, HTMLSpanElement>();
  private visible = false;
  private lastUpdate = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud__title">PERF</div>
      <div class="hud__grid"></div>
    `;
    parent.appendChild(this.el);
    this.buildRow('fps', 'FPS');
    this.buildRow('frame', 'frame');
    this.buildRow('p95', 'p95');
    this.buildRow('calls', 'draw');
    this.buildRow('tris', 'tris');
    this.buildRow('tex', 'tex');
    this.buildRow('tier', 'tier');
  }

  private buildRow(key: string, label: string): void {
    const grid = this.el.querySelector('.hud__grid') as HTMLDivElement;
    const row = document.createElement('div');
    row.className = 'hud__row';
    const k = document.createElement('span');
    k.className = 'hud__key';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'hud__val';
    v.textContent = '—';
    row.append(k, v);
    grid.appendChild(row);
    this.rows.set(key, v);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.el.classList.toggle('is-visible', visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  update(data: HudData): void {
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.lastUpdate < 200) return;
    this.lastUpdate = now;

    const { loop, renderer } = data;
    this.set('fps', loop.fps.toFixed(0), loop.fps >= 55 ? 'ok' : loop.fps >= 40 ? 'warn' : 'bad');
    this.set('frame', `${loop.frameMs.toFixed(1)}ms`);
    this.set('p95', `${loop.p95FrameMs.toFixed(1)}ms`, loop.p95FrameMs > 22 ? 'warn' : undefined);
    this.set('calls', String(renderer.drawCalls), renderer.drawCalls > 220 ? 'warn' : undefined);
    this.set('tris', formatTris(renderer.triangles));
    this.set('tex', `${renderer.textures} / ${renderer.textureMemoryMB.toFixed(0)}MB`);
    this.set('tier', data.tier);

    if (data.extra) {
      for (const [k, v] of Object.entries(data.extra)) {
        if (!this.rows.has(k)) this.buildRow(k, k);
        this.set(k, v);
      }
    }
  }

  private set(key: string, text: string, tone?: 'ok' | 'warn' | 'bad'): void {
    const el = this.rows.get(key);
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    el.dataset.tone = tone ?? '';
  }

  dispose(): void {
    this.el.remove();
    this.rows.clear();
  }
}

function formatTris(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
