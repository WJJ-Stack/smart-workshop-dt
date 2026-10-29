import * as THREE from 'three';
import type { EntityRegistry } from '../entities/EntityRegistry';
import type { TwinSnapshot, TwinSource } from './TwinSource';
import type { TwinStatus } from '../shared/events';

/**
 * 孪生状态可视化：把数据投影到 3D 上。
 *
 * 三种投影手段，按「信息强度」递增、按「性能开销」递增：
 *   1. 状态灯材质替换（最便宜：只改 emissive 颜色）
 *   2. 设备整体轻微自发光提示（告警时才用，避免画面花）
 *   3. 热点标签文案更新（DOM，零 GPU 开销）
 *
 * 关键取舍：不做「数据飘字」的粒子特效。演示场景里那类效果会盖住模型本身，
 * 且开销不可控。把状态编码进颜色 + 标签就够了。
 */
export interface TwinBindingOptions {
  registry: EntityRegistry;
  source: TwinSource;
  onSnapshot?: (snaps: TwinSnapshot[]) => void;
  onStatusChange?: (entityId: string, status: TwinStatus, prev: TwinStatus) => void;
}

const STATUS_EMISSIVE: Record<TwinStatus, THREE.Color> = {
  running: new THREE.Color(0x2fe08a),
  idle: new THREE.Color(0xffb545),
  fault: new THREE.Color(0xff3b3b),
  maintenance: new THREE.Color(0xffa030),
};

const STATUS_INTENSITY: Record<TwinStatus, number> = {
  running: 3.6,
  idle: 2.6,
  fault: 5.2,
  maintenance: 3.0,
};

export class TwinBinding {
  private readonly opts: TwinBindingOptions;
  private readonly unsub: Array<() => void> = [];
  private readonly lampMaterials = new Map<string, THREE.MeshStandardMaterial[]>();
  private readonly lastStatus = new Map<string, TwinStatus>();
  private readonly pendingSnaps: TwinSnapshot[] = [];
  private draining = false;

  constructor(opts: TwinBindingOptions) {
    this.opts = opts;
    this.collectLamps();
    this.unsub.push(
      opts.source.subscribe((snaps) => {
        // 数据源是 8Hz，渲染是 60Hz+；这里只入队，不直接改材质，
        // 真正的应用在帧循环里做（保证一帧内材质只改一次）
        this.pendingSnaps.push(...snaps);
      }),
    );
  }

  /** 收集所有状态灯网格，并克隆材质（避免多个灯共享材质导致一起变色） */
  private collectLamps(): void {
    for (const entity of this.opts.registry.listEntities()) {
      const lamps: THREE.MeshStandardMaterial[] = [];
      for (const part of entity.parts) {
        if (part.role !== 'status_lamp') continue;
        const mat = part.mesh.material as THREE.MeshStandardMaterial;
        if (!mat?.isMeshStandardMaterial) continue;
        const cloned = mat.clone();
        cloned.name = `${mat.name}__lamp_${entity.id}`;
        part.mesh.material = cloned;
        lamps.push(cloned);
      }
      if (lamps.length > 0) this.lampMaterials.set(entity.id, lamps);
    }
    console.info(`[TwinBinding] 状态灯绑定：${this.lampMaterials.size} 台设备`);
  }

  /**
   * 每帧调用。把累积的快照一次性应用到 3D 与 UI。
   * 用「合并到最新」策略：如果一帧内积压了多个快照，只保留每个实体的最后一个。
   */
  update(): void {
    if (this.pendingSnaps.length === 0) return;

    const latest = new Map<string, TwinSnapshot>();
    for (const snap of this.pendingSnaps) latest.set(snap.entityId, snap);
    this.pendingSnaps.length = 0;

    const applied: TwinSnapshot[] = [];

    for (const snap of latest.values()) {
      const prev = this.lastStatus.get(snap.entityId);
      if (prev === snap.status) continue;
      this.lastStatus.set(snap.entityId, snap.status);

      const lamps = this.lampMaterials.get(snap.entityId);
      if (lamps) {
        const color = STATUS_EMISSIVE[snap.status];
        const intensity = STATUS_INTENSITY[snap.status];
        for (const mat of lamps) {
          mat.emissive.copy(color);
          mat.emissiveIntensity = intensity;
          mat.needsUpdate = true;
        }
      }
      applied.push(snap);
      this.opts.onStatusChange?.(snap.entityId, snap.status, prev ?? 'idle');
    }

    if (latest.size > 0) {
      this.opts.onSnapshot?.([...latest.values()]);
    }
  }

  /** 当前状态（供 UI 初始化时读取） */
  statusOf(entityId: string): TwinStatus | undefined {
    return this.lastStatus.get(entityId);
  }

  dispose(): void {
    for (const fn of this.unsub) fn();
    this.unsub.length = 0;
    for (const lamps of this.lampMaterials.values()) {
      for (const mat of lamps) mat.dispose();
    }
    this.lampMaterials.clear();
    this.lastStatus.clear();
    this.pendingSnaps.length = 0;
    void this.draining;
  }
}
