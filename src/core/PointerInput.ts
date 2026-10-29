/**
 * 指针输入层：把原始 PointerEvent 归一化成「业务语义事件」。
 *
 * 为什么需要它：
 * - 区分「点击」与「拖拽旋转」：没有位移阈值的话，每次转动视角松手都会误触发拾取；
 * - 长按（移动端）与右键（桌面端）语义统一；
 * - 悬停只在桌面端启用，且做节流，避免每帧 raycast。
 */
export interface PointerSnapshot {
  /** 归一化设备坐标 [-1, 1] */
  ndcX: number;
  ndcY: number;
  /** 相对 canvas 的 CSS 像素坐标 */
  clientX: number;
  clientY: number;
  pointerId: number;
  button: number;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ClickPayload extends PointerSnapshot {
  /** 按下到抬起的位移（CSS 像素） */
  travel: number;
  /** 按压时长（毫秒） */
  durationMs: number;
}

export interface HoverPayload extends PointerSnapshot {}

export type PointerHandler<T> = (payload: T) => void;

const CLICK_TRAVEL_PX = 6;
const CLICK_MAX_MS = 700;
const HOVER_THROTTLE_MS = 40;

export class PointerInput {
  private readonly el: HTMLElement;
  private readonly clickHandlers = new Set<PointerHandler<ClickPayload>>();
  private readonly hoverHandlers = new Set<PointerHandler<HoverPayload>>();
  private readonly downHandlers = new Set<PointerHandler<PointerSnapshot>>();
  private readonly cancelHandlers = new Set<() => void>();

  private activePointerId: number | null = null;
  private downX = 0;
  private downY = 0;
  private downTime = 0;
  private downButton = 0;
  private lastHoverAt = 0;
  private pendingHover: PointerEvent | null = null;
  private hoverRaf = 0;
  private hoverEnabled = true;
  private disposed = false;

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('pointerdown', this.onPointerDown, { passive: true });
    el.addEventListener('pointerup', this.onPointerUp, { passive: true });
    el.addEventListener('pointercancel', this.onPointerCancel, { passive: true });
    el.addEventListener('pointermove', this.onPointerMove, { passive: true });
    el.addEventListener('pointerleave', this.onPointerLeave, { passive: true });
    el.addEventListener('contextmenu', this.onContextMenu);
  }

  setHoverEnabled(enabled: boolean): void {
    this.hoverEnabled = enabled;
  }

  onClick(fn: PointerHandler<ClickPayload>): () => void {
    this.clickHandlers.add(fn);
    return () => this.clickHandlers.delete(fn);
  }

  onHover(fn: PointerHandler<HoverPayload>): () => void {
    this.hoverHandlers.add(fn);
    return () => this.hoverHandlers.delete(fn);
  }

  /** 按下即触发，用于打断相机飞行、收起弹层等 */
  onDown(fn: PointerHandler<PointerSnapshot>): () => void {
    this.downHandlers.add(fn);
    return () => this.downHandlers.delete(fn);
  }

  /** 手势被系统打断（如触摸滚动、Alt+Tab），用于清理悬停态 */
  onCancel(fn: () => void): () => void {
    this.cancelHandlers.add(fn);
    return () => this.cancelHandlers.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    const el = this.el;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerCancel);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    el.removeEventListener('contextmenu', this.onContextMenu);
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf);
    this.clickHandlers.clear();
    this.hoverHandlers.clear();
    this.downHandlers.clear();
    this.cancelHandlers.clear();
  }

  private toSnapshot(e: PointerEvent): PointerSnapshot {
    const rect = this.el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      ndcX: (x / Math.max(1, rect.width)) * 2 - 1,
      ndcY: -(y / Math.max(1, rect.height)) * 2 + 1,
      clientX: x,
      clientY: y,
      pointerId: e.pointerId,
      button: e.button,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.disposed) return;
    // 只跟踪主指针，多点触控交给 OrbitControls 自己处理缩放
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.activePointerId = e.pointerId;
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downTime = performance.now();
    this.downButton = e.button;
    const snap = this.toSnapshot(e);
    for (const fn of this.downHandlers) fn(snap);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.disposed) return;
    if (this.activePointerId !== e.pointerId) return;
    this.activePointerId = null;

    const travel = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    const durationMs = performance.now() - this.downTime;
    if (travel > CLICK_TRAVEL_PX || durationMs > CLICK_MAX_MS) {
      for (const fn of this.cancelHandlers) fn();
      return;
    }

    const snap = this.toSnapshot(e);
    const payload: ClickPayload = {
      ...snap,
      button: this.downButton,
      travel,
      durationMs,
    };
    for (const fn of this.clickHandlers) fn(payload);
  };

  private readonly onPointerCancel = (): void => {
    this.activePointerId = null;
    for (const fn of this.cancelHandlers) fn();
  };

  private readonly onPointerLeave = (): void => {
    for (const fn of this.cancelHandlers) fn();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.disposed || !this.hoverEnabled) return;
    if (this.hoverHandlers.size === 0) return;
    // 拖拽中不更新 hover，避免高频 raycast
    if (this.activePointerId !== null) return;

    const now = performance.now();
    if (now - this.lastHoverAt < HOVER_THROTTLE_MS) {
      this.pendingHover = e;
      if (!this.hoverRaf) {
        this.hoverRaf = requestAnimationFrame(() => {
          this.hoverRaf = 0;
          const pending = this.pendingHover;
          this.pendingHover = null;
          if (!pending || this.disposed) return;
          this.lastHoverAt = performance.now();
          const snap = this.toSnapshot(pending);
          for (const fn of this.hoverHandlers) fn(snap);
        });
      }
      return;
    }
    this.lastHoverAt = now;
    const snap = this.toSnapshot(e);
    for (const fn of this.hoverHandlers) fn(snap);
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };
}
