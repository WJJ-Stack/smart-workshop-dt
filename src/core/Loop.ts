/**
 * 主循环：单一 rAF 驱动，按注册顺序执行 updater。
 *
 * 设计要点：
 * - delta 有上限钳制，避免切标签页回来后物理/动画瞬移；
 * - 每个 updater 可声明 priority，保证「输入 → 逻辑 → 动画 → UI」顺序稳定；
 * - 内置帧耗时统计（EMA + p95 采样），供性能 HUD 与自适应降级使用。
 */
export interface FrameInfo {
  /** 钳制后的秒级步长 */
  delta: number;
  /** 真实经过时间（秒），未钳制 */
  rawDelta: number;
  /** 累计运行时间（秒） */
  elapsed: number;
  frame: number;
}

export type Updater = (frame: FrameInfo) => void;

export interface LoopStats {
  fps: number;
  frameMs: number;
  p95FrameMs: number;
  cpuMs: number;
}

interface Entry {
  fn: Updater;
  priority: number;
}

const MAX_DELTA = 1 / 15;

export class Loop {
  readonly stats: LoopStats = { fps: 0, frameMs: 0, p95FrameMs: 0, cpuMs: 0 };

  private entries: Entry[] = [];
  private rafId = 0;
  private lastTime = 0;
  private accumElapsed = 0;
  private frameCount = 0;
  private running = false;

  private readonly samples: Float32Array;
  private sampleIndex = 0;
  private sampleFilled = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor(maxSamples = 120) {
    this.samples = new Float32Array(maxSamples);
  }

  add(fn: Updater, priority = 0): () => void {
    this.entries.push({ fn, priority });
    this.entries.sort((a, b) => a.priority - b.priority);
    return () => {
      this.entries = this.entries.filter((e) => e.fn !== fn);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const cpuStart = performance.now();
    const rawDelta = (now - this.lastTime) / 1000;
    this.lastTime = now;

    const delta = Math.min(rawDelta, MAX_DELTA);
    this.accumElapsed += delta;
    this.frameCount += 1;

    const frame: FrameInfo = {
      delta,
      rawDelta,
      elapsed: this.accumElapsed,
      frame: this.frameCount,
    };

    for (const entry of this.entries) entry.fn(frame);

    const cpuMs = performance.now() - cpuStart;
    this.record(rawDelta * 1000, cpuMs);
  };

  private record(frameMs: number, cpuMs: number): void {
    this.samples[this.sampleIndex] = frameMs;
    this.sampleIndex = (this.sampleIndex + 1) % this.samples.length;
    this.sampleFilled = Math.min(this.sampleFilled + 1, this.samples.length);

    this.fpsAccum += frameMs;
    this.fpsFrames += 1;

    // 每 ~500ms 刷新一次统计，避免 HUD 抖动
    if (this.fpsAccum >= 500) {
      const avgMs = this.fpsAccum / this.fpsFrames;
      this.stats.fps = 1000 / avgMs;
      this.stats.frameMs = avgMs;
      this.stats.p95FrameMs = this.percentile(0.95);
      this.stats.cpuMs = cpuMs;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
  }

  private percentile(p: number): number {
    if (this.sampleFilled === 0) return 0;
    const view = Array.from(this.samples.subarray(0, this.sampleFilled)).sort((a, b) => a - b);
    const idx = Math.min(view.length - 1, Math.floor(view.length * p));
    return view[idx] ?? 0;
  }
}
