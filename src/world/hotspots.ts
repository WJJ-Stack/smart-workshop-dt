import * as THREE from 'three';
import type { EntityRegistry } from '../entities/EntityRegistry';
import type { AssetManifest } from '../assets/manifest';
import type { HotspotSpec } from '../interaction/HotspotLayer';

/**
 * 热点生成器。
 *
 * 不从 Blender 硬编码热点坐标，而是**从实体包围盒推导**：
 *   锚点 = 实体世界包围盒顶面中心上方 0.35m
 *
 * 这样做的好处是模型改版后热点自动跟着走，不会「模型动了热点飘在空中」。
 * 真正的项目里，热点位置应该来自工艺/运维人员标注，但那需要后端；
 * 在纯前端作品里，几何推导是更负责任的选择。
 */
export class HotspotBuilder {
  private readonly registry: EntityRegistry;
  private readonly manifest: AssetManifest;
  private readonly hotspotEntity = new Map<string, string>();

  constructor(registry: EntityRegistry, manifest: AssetManifest) {
    this.registry = registry;
    this.manifest = manifest;
  }

  entityOf(hotspotId: string): string | undefined {
    return this.hotspotEntity.get(hotspotId);
  }

  build(onClick: (hotspotId: string) => void): HotspotSpec[] {
    return this.buildRebuild(onClick);
  }

  /**
   * 重建热点（位置依据当前包围盒重新计算）。
   * LOD 切换后实体几何变了，热点锚点必须重算，否则会飘在空中或陷进模型。
   */
  buildRebuild(onClick: (hotspotId: string) => void): HotspotSpec[] {
    const specs: HotspotSpec[] = [];

    const add = (
      entityId: string,
      title: string,
      subtitle: string,
      tone: HotspotSpec['tone'],
      offsetY = 0.4,
    ): void => {
      const bounds = this.registry.boundsOf(entityId);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new THREE.Vector3());
      const top = bounds.max.y;
      const position = new THREE.Vector3(center.x, top + offsetY, center.z);

      const id = `hs_${entityId}`;
      this.hotspotEntity.set(id, entityId);
      specs.push({ id, entityId, position, title, subtitle, tone, onClick });
    };

    // 只给关键工位加热点，避免「满屏标签」
    const stationTitle: Record<string, (title: string) => [string, string, HotspotSpec['tone']]> = {
      EQ_feeder_01: () => ['上料 · 料位 74%', '工位 01', 'ok'],
      EQ_robot_01: () => ['装配臂 #1 · 运行中', '节拍 28.4s', 'ok'],
      EQ_inspect_01: () => ['视觉检测 · 良率 98.6%', '工位 05', 'ok'],
      EQ_robot_02: () => ['装配臂 #2 · 运行中', '节拍 30.1s', 'ok'],
      EQ_packer_01: () => ['包装码垛 · 184/h', '工位 08', 'ok'],
      EQ_agv_01: () => ['AGV #1 · 电量 86%', '任务进行中', 'info'],
      EQ_agv_02: () => ['AGV #2 · 待命', '充电桩区', 'warn'],
      EQ_console_01: () => ['中控台', '车间总览', 'info'],
    };

    for (const entity of this.registry.listEntities()) {
      const maker = stationTitle[entity.id];
      if (!maker) continue;
      const [title, subtitle, tone] = maker(entity.title);
      add(entity.id, title, subtitle, tone);
    }

    // 若无任何预设命中（例如模型改名），退化为给前三台设备各加一个
    if (specs.length === 0) {
      for (const entity of this.registry.listEntities().slice(0, 3)) {
        add(entity.id, entity.title, `工位 ${entity.station}`, 'info');
      }
    }

    console.info(`[HotspotBuilder] 生成 ${specs.length} 个热点`);
    void this.manifest;
    return specs;
  }
}
