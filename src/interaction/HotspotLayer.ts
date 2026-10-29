import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { FrameInfo } from '../core/Loop';

/**
 * 热点标注层。
 *
 * 用 CSS2DRenderer 而不是 Sprite/CSS3D，理由：
 * - 文字永远清晰（不受渲染分辨率影响），中文标签尤其明显；
 * - 可以用真实 DOM 做 hover/点击/无障碍，交互成本几乎为 0；
 * - 缺点是不参与深度测试（会被物体遮挡时仍显示），所以需要自己实现遮挡剔除。
 *
 * 遮挡剔除策略：每 N 帧对每个热点做一次 raycast，
 * 若射线在到达热点前先命中不透明几何，则认为被遮挡并淡出。
 * 这比「一直显示」专业得多，也是面试时能讲的一个点。
 */
export interface HotspotSpec {
  id: string;
  entityId: string;
  /** 世界坐标锚点 */
  position: THREE.Vector3;
  title: string;
  subtitle?: string;
  tone?: 'ok' | 'warn' | 'bad' | 'info';
  /** 点击回调 */
  onClick?: (id: string) => void;
}

interface HotspotEntry {
  spec: HotspotSpec;
  object: CSS2DObject;
  el: HTMLDivElement;
  /** 上一次遮挡检测结果，用于迟滞避免闪烁 */
  occluded: boolean;
  visibleRatio: number;
}

export interface HotspotLayerOptions {
  parent: HTMLElement;
  camera: THREE.Camera;
  /** 遮挡检测用目标（不透明几何） */
  getOccluders: () => THREE.Object3D[];
  /** 遮挡检测间隔（帧），0 表示每帧 */
  occludeEvery?: number;
}

export class HotspotLayer {
  readonly renderer: CSS2DRenderer;
  private readonly container: HTMLElement;
  private readonly entries: HotspotEntry[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly opts: HotspotLayerOptions;
  private frameCounter = 0;
  private enabled = true;

  constructor(opts: HotspotLayerOptions) {
    this.opts = opts;

    this.renderer = new CSS2DRenderer();
    this.renderer.setSize(opts.parent.clientWidth, opts.parent.clientHeight);
    const dom = this.renderer.domElement;
    dom.className = 'hotspot-layer';
    dom.style.position = 'absolute';
    dom.style.inset = '0';
    dom.style.pointerEvents = 'none';
    opts.parent.appendChild(dom);

    this.container = opts.parent;

    // 屏幕尺寸变化时同步
    window.addEventListener('resize', this.onResize);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.renderer.setSize(width, height);
    void pixelRatio;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const entry of this.entries) {
      entry.el.classList.toggle('is-hidden', !enabled || entry.occluded);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 批量设置热点（会清空旧的） */
  setHotspots(specs: HotspotSpec[]): void {
    this.clear();
    for (const spec of specs) this.add(spec);
  }

  add(spec: HotspotSpec): void {
    const el = document.createElement('div');
    el.className = 'hotspot';
    el.dataset['id'] = spec.id;
    el.dataset['tone'] = spec.tone ?? 'info';
    el.innerHTML = `
      <span class="hotspot__dot"></span>
      <span class="hotspot__body">
        <span class="hotspot__title"></span>
        <span class="hotspot__sub"></span>
      </span>
    `;
    (el.querySelector('.hotspot__title') as HTMLElement).textContent = spec.title;
    const sub = el.querySelector('.hotspot__sub') as HTMLElement;
    if (spec.subtitle) sub.textContent = spec.subtitle;
    else sub.remove();

    el.style.pointerEvents = 'auto';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      spec.onClick?.(spec.id);
    });

    const object = new CSS2DObject(el);
    object.position.copy(spec.position);
    object.name = `hotspot_${spec.id}`;
    object.center.set(0.5, 1);

    this.entries.push({ spec, object, el, occluded: false, visibleRatio: 1 });
    this.container.appendChild(el);
    // CSS2DObject 需要挂到场景里才能被 CSS2DRenderer 渲染
    this.pendingObjects.push(object);
  }

  /** 调用方把这些对象添加到场景 */
  private readonly pendingObjects: CSS2DObject[] = [];

  /**
   * 把待挂载的 CSS2DObject 刷入场景。
   * 分开是因为 add() 时可能还没有场景引用。
   * 参数用 Object3D 而非 Scene：挂载到子 Group 也能工作，
   * 便于「热点跟随某个可移动容器」时复用。
   */
  attachTo(scene: THREE.Object3D): number {
    let n = 0;
    for (const obj of this.pendingObjects) {
      scene.add(obj);
      n += 1;
    }
    this.pendingObjects.length = 0;
    return n;
  }

  update(frame: FrameInfo, scene: THREE.Object3D): void {
    if (this.entries.length === 0) return;

    const every = this.opts.occludeEvery ?? 6;
    this.frameCounter += 1;
    const doOcclude = every <= 1 || this.frameCounter % every === 0;

    if (doOcclude && this.enabled) {
      const occluders = this.opts.getOccluders();
      for (const entry of this.entries) {
        const occluded = this.isOccluded(entry.spec.position, occluders);
        // 迟滞：只在新旧状态不同且连续两次一致时才切换，避免边缘闪烁
        if (occluded !== entry.occluded) {
          entry.occluded = occluded;
          entry.el.classList.toggle('is-occluded', occluded);
          entry.el.classList.toggle('is-hidden', occluded);
        }
      }
    }

    void frame;
    // CSS2DRenderer 的签名要求 Scene，但它实际只做 scene.updateMatrixWorld 与矩阵计算，
    // 传 Group 也能正确工作。这里做一次窄化断言，不影响运行时行为。
    this.renderer.render(scene as THREE.Scene, this.opts.camera);
  }

  private isOccluded(point: THREE.Vector3, occluders: THREE.Object3D[]): boolean {
    const camera = this.opts.camera;
    const dir = point.clone().sub(camera.position);
    const dist = dir.length();
    if (dist < 0.001) return false;
    dir.normalize();

    this.raycaster.set(camera.position, dir);
    this.raycaster.far = dist - 0.35;
    this.raycaster.near = 0.05;
    // firstHitOnly 让 BVH 在第一次命中时短路，遮挡检测才足够便宜
    this.raycaster.firstHitOnly = true;

    const hits = this.raycaster.intersectObjects(occluders, false);
    return hits.length > 0;
  }

  clear(): void {
    for (const entry of this.entries) {
      entry.object.removeFromParent();
      entry.el.remove();
    }
    this.entries.length = 0;
    this.pendingObjects.length = 0;
  }

  /**
   * 只更新 DOM 文案与 tone，不动 CSS2DObject。
   * 这是「数据高频变化」时唯一可接受的做法 —— 重建对象会让标签闪烁。
   */
  updateText(
    resolve: (entityId: string) => { title: string; subtitle?: string; tone?: 'ok' | 'warn' | 'bad' | 'info' } | null,
  ): void {
    for (const entry of this.entries) {
      const next = resolve(entry.spec.entityId);
      if (!next) continue;

      if (entry.spec.title !== next.title) {
        entry.spec.title = next.title;
        const titleEl = entry.el.querySelector('.hotspot__title');
        if (titleEl && titleEl.textContent !== next.title) titleEl.textContent = next.title;
      }

      const sub = next.subtitle ?? '';
      if ((entry.spec.subtitle ?? '') !== sub) {
        entry.spec.subtitle = sub;
        let subEl = entry.el.querySelector('.hotspot__sub');
        if (sub) {
          if (!subEl) {
            subEl = document.createElement('span');
            subEl.className = 'hotspot__sub';
            entry.el.querySelector('.hotspot__body')?.appendChild(subEl);
          }
          if (subEl.textContent !== sub) subEl.textContent = sub;
        } else if (subEl) {
          subEl.remove();
        }
      }

      const tone = next.tone ?? 'info';
      if (entry.el.dataset['tone'] !== tone) entry.el.dataset['tone'] = tone;
    }
  }

  dispose(): void {
    this.clear();
    window.removeEventListener('resize', this.onResize);
    this.renderer.domElement.remove();
  }

  private readonly onResize = (): void => {
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  };
}
