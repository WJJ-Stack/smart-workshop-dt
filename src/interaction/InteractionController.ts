import * as THREE from 'three';
import type { App } from '../App';
import type { EntityRegistry, PartInfo } from '../entities/EntityRegistry';
import { Highlighter } from './Highlighter';
import { HotspotLayer, type HotspotSpec } from './HotspotLayer';
import { Picker, type PickResult } from './Picker';

/**
 * 交互控制器：把「原始指针事件」翻译成「业务语义」。
 *
 * 职责链：
 *   PointerInput → Picker(BVH) → EntityRegistry.resolve → Highlighter + 事件总线
 *
 * 分层选择事件而不是回调：
 * 交互产生的意图（选中了什么、悬停了什么）需要被 UI 面板、相机、孪生数据
 * 多个消费者同时订阅。事件总线天然支持一对多，且耦合最低。
 */
export interface InteractionEvents extends Record<string, unknown> {
  'pick:hover': { part: PartInfo | null; point: THREE.Vector3 | null };
  'pick:select': { parts: PartInfo[]; entityIds: string[] };
  'pick:clear': Record<string, never>;
  'hotspot:click': { id: string; entityId: string };
}

export interface InteractionControllerOptions {
  app: App;
  registry: EntityRegistry;
  /** 父容器，用于挂 CSS2D 标注层 */
  overlay: HTMLElement;
  /** 遮挡检测用的几何（通常是已合并的静态件 + 设备） */
  getOccluders: () => THREE.Object3D[];
}

export class InteractionController {
  readonly highlighter = new Highlighter();
  readonly hotspots: HotspotLayer;
  private readonly picker: Picker;
  private readonly opts: InteractionControllerOptions;
  private readonly unsub: Array<() => void> = [];

  private hoveredEntity: string | null = null;
  private selectedEntity: string | null = null;
  private hoverRaf = 0;
  private pendingHover: { x: number; y: number } | null = null;
  /** 每帧最多处理一次 hover 拾取，避免高频 raycast */
  private hoverEnabled = true;
  /** 热点所在的场景根，update 时传给 CSS2DRenderer */
  private hotspotScene: THREE.Object3D | null = null;

  constructor(opts: InteractionControllerOptions) {
    this.opts = opts;

    this.picker = new Picker({
      registry: opts.registry,
      camera: opts.app.rig.camera,
      getTargets: () => opts.registry.allInteractiveMeshes(),
    });

    this.hotspots = new HotspotLayer({
      parent: opts.overlay,
      camera: opts.app.rig.camera,
      getOccluders: opts.getOccluders,
      occludeEvery: 8,
    });

    this.bindPointer();

    opts.app.loop.add((f) => {
      this.highlighter.update(f.delta);
      this.hotspots.update(f, this.hotspotScene ?? opts.app.scene);
    }, 20);

    this.unsub.push(
      opts.app.viewport.onChange((m) => {
        this.hotspots.setSize(m.width, m.height, m.pixelRatio);
      }),
    );
  }

  /** 场景就绪后调用一次，构建 BVH */
  prepare(): { meshes: number; ms: number } {
    return this.picker.buildBvh();
  }

  /** 供测试/脚本调用的直接拾取（不经过指针事件） */
  pickAt(ndcX: number, ndcY: number): PickResult | null {
    return this.picker.pick(ndcX, ndcY);
  }

  /** 供自动化测试触发一次「点击」语义 */
  clickAt(ndcX: number, ndcY: number): boolean {
    const before = this.selectedEntity;
    this.handleClick(ndcX, ndcY, false);
    return this.selectedEntity !== before;
  }

  /** 热点挂载到场景 */
  attachHotspots(scene: THREE.Object3D): void {
    this.hotspotScene = scene;
    this.hotspots.attachTo(scene);
  }

  setHoverEnabled(enabled: boolean): void {
    this.hoverEnabled = enabled;
    if (!enabled) {
      this.highlighter.setHover([]);
      this.opts.app.renderer.gl.domElement.style.cursor = 'grab';
    }
  }

  setHotspots(specs: HotspotSpec[]): void {
    this.hotspots.setHotspots(specs);
  }

  /**
   * 批量更新热点文案（不改位置，只改 DOM 文本与 tone）。
   *
   * 单独开一个方法而不是重建热点，因为重建会导致：
   * 1. CSS2DObject 反复创建销毁 → GC 压力；
   * 2. 节点 hover 状态丢失 → 用户正在看的标签闪一下。
   */
  updateHotspotText(
    resolve: (entityId: string) => { title: string; subtitle?: string; tone?: 'ok' | 'warn' | 'bad' | 'info' } | null,
  ): void {
    this.hotspots.updateText(resolve);
  }

  /** 选中某个实体（供 UI 列表点击时调用） */
  selectEntity(entityId: string | null): void {
    if (entityId === null) {
      this.selectedEntity = null;
      this.highlighter.clearSelection();
      this.opts.app.bus.emit('pick:clear', {});
      return;
    }
    const meshes = this.opts.registry.meshesOf(entityId);
    if (meshes.length === 0) return;
    this.selectedEntity = entityId;
    this.highlighter.setSelection(meshes);
    const entity = this.opts.registry.getEntity(entityId);
    const parts = entity ? entity.parts : [];
    this.opts.app.bus.emit('pick:select', { parts, entityIds: [entityId] });
  }

  get currentSelection(): string | null {
    return this.selectedEntity;
  }

  /** 飞向并选中某实体（设备列表 / 热点共用） */
  focusEntity(entityId: string, opts: { select?: boolean; fly?: boolean } = {}): void {
    const entity = this.opts.registry.getEntity(entityId);
    if (!entity) return;

    if (opts.select !== false) this.selectEntity(entityId);

    if (opts.fly !== false) {
      const bounds = this.opts.registry.boundsOf(entityId);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, 0.6);
      const distance = Math.max(4.2, radius * 3.1);
      const pos = center
        .clone()
        .add(new THREE.Vector3(distance * 0.62, distance * 0.56, distance * 0.72));
      this.opts.app.flyTo({ position: pos, target: center, fov: 42, duration: 1.1 });
    }
  }

  dispose(): void {
    for (const fn of this.unsub) fn();
    this.unsub.length = 0;
    if (this.hoverRaf) cancelAnimationFrame(this.hoverRaf);
    this.hotspots.dispose();
    this.highlighter.dispose();
    this.picker.dispose();
  }

  // ---------------------------------------------------------------- 内部

  private bindPointer(): void {
    const { app } = this.opts;

    this.unsub.push(
      app.input.onHover((p) => {
        if (!this.hoverEnabled) return;
        if (app.rig.transition.active) return;
        this.pendingHover = { x: p.ndcX, y: p.ndcY };
        if (this.hoverRaf) return;
        // 合并到下一帧，避免一次 pointermove 触发多次 raycast
        this.hoverRaf = requestAnimationFrame(() => {
          this.hoverRaf = 0;
          const pending = this.pendingHover;
          this.pendingHover = null;
          if (!pending) return;
          this.handleHover(pending.x, pending.y);
        });
      }),
    );

    this.unsub.push(
      app.input.onClick((p) => {
        // 右键 / 中键 / 带修饰键交给相机控制器
        if (p.button !== 0) return;
        if (p.shiftKey || p.altKey) return;
        this.handleClick(p.ndcX, p.ndcY, p.shiftKey);
      }),
    );

    this.unsub.push(
      app.input.onCancel(() => {
        this.highlighter.setHover([]);
        this.hoveredEntity = null;
      }),
    );
  }

  private handleHover(x: number, y: number): void {
    const hit = this.picker.pick(x, y);
    const canvas = this.opts.app.renderer.gl.domElement;

    if (!hit) {
      if (this.hoveredEntity !== null) {
        this.highlighter.setHover([]);
        this.hoveredEntity = null;
        this.opts.app.bus.emit('pick:hover', { part: null, point: null });
      }
      canvas.style.cursor = 'grab';
      return;
    }

    canvas.style.cursor = 'pointer';
    if (hit.part.entityId === this.hoveredEntity) return;

    this.hoveredEntity = hit.part.entityId;
    // 悬停只高亮当前部件，不做整机高亮 —— 这样「部件级拾取」才能被看见
    this.highlighter.setHover([hit.part.mesh]);
    this.opts.app.bus.emit('pick:hover', { part: hit.part, point: hit.point });
  }

  private handleClick(x: number, y: number, additive: boolean): void {
    const hit: PickResult | null = this.picker.pick(x, y);

    if (!hit) {
      if (!additive) {
        this.selectedEntity = null;
        this.highlighter.clearSelection();
        this.opts.app.bus.emit('pick:clear', {});
      }
      return;
    }

    const entityId = hit.part.entityId;

    if (additive) {
      const meshes = this.opts.registry.meshesOf(entityId);
      this.highlighter.toggleSelection(meshes);
      this.selectedEntity = entityId;
      const entity = this.opts.registry.getEntity(entityId);
      this.opts.app.bus.emit('pick:select', {
        parts: entity?.parts ?? [],
        entityIds: [entityId],
      });
      return;
    }

    // 单击已选中的实体 → 取消选中（常见交互习惯）
    if (this.selectedEntity === entityId) {
      this.selectedEntity = null;
      this.highlighter.clearSelection();
      this.opts.app.bus.emit('pick:clear', {});
      return;
    }

    // 整机高亮：点击任一部件，高亮同实体全部部件
    const meshes = this.opts.registry.meshesOf(entityId);
    this.selectedEntity = entityId;
    this.highlighter.setSelection(meshes);

    const entity = this.opts.registry.getEntity(entityId);
    this.opts.app.bus.emit('pick:select', {
      parts: entity?.parts ?? [],
      entityIds: [entityId],
    });
  }
}
