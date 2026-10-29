import * as THREE from 'three';
import type { EquipmentKind } from '../assets/manifest';

/**
 * 实体注册表：3D 对象与业务数据的唯一映射。
 *
 * 这是整个交互体系的地基。拾取系统只需要问它三个问题：
 *   1. 这个 mesh 属于哪个实体的哪个部件？
 *   2. 这个实体的所有部件是哪些（用于整体高亮）？
 *   3. 这个实体是什么设备类型、在哪个工位？
 *
 * 性能关键：
 * - partsByMesh 是 WeakMap，不做遍历查找，raycast 命中的瞬间 O(1) 命中；
 * - meshesByEntity 用数组而非 Set，高亮时需要顺序稳定且能直接塞进 raycaster。
 */
export interface PartInfo {
  entityId: string;
  partId: string;
  mesh: THREE.Mesh;
  root: THREE.Object3D;
  kind: EquipmentKind;
  title: string;
  station: number;
  role?: string | undefined;
  joint?: string | undefined;
}

export interface Entity {
  id: string;
  kind: EquipmentKind;
  title: string;
  station: number;
  root: THREE.Object3D;
  parts: PartInfo[];
  /** 世界空间包围盒（惰性计算后缓存） */
  bounds: THREE.Box3;
  boundsDirty: boolean;
}

export class EntityRegistry {
  private readonly entities = new Map<string, Entity>();
  private readonly partsByMesh = new WeakMap<THREE.Object3D, PartInfo>();
  private readonly staticMeshes: THREE.Mesh[] = [];

  get entityCount(): number {
    return this.entities.size;
  }

  get staticCount(): number {
    return this.staticMeshes.length;
  }

  registerPart(input: Omit<PartInfo, 'partId'> & { partId: string }): void {
    let entity = this.entities.get(input.entityId);
    if (!entity) {
      entity = {
        id: input.entityId,
        kind: input.kind,
        title: input.title,
        station: input.station,
        root: input.root,
        parts: [],
        bounds: new THREE.Box3(),
        boundsDirty: true,
      };
      this.entities.set(input.entityId, entity);
    }

    const info: PartInfo = {
      entityId: input.entityId,
      partId: input.partId,
      mesh: input.mesh,
      root: entity.root,
      kind: entity.kind,
      title: entity.title,
      station: entity.station,
      role: input.role,
      joint: input.joint,
    };

    entity.parts.push(info);
    entity.boundsDirty = true;
    this.partsByMesh.set(input.mesh, info);
  }

  registerStatic(mesh: THREE.Mesh): void {
    this.staticMeshes.push(mesh);
  }

  /** raycast 命中后调用，返回部件信息 */
  resolve(object: THREE.Object3D): PartInfo | null {
    // 命中点可能落在子节点上，向上找最近的已注册 mesh
    let cur: THREE.Object3D | null = object;
    while (cur) {
      const info = this.partsByMesh.get(cur);
      if (info) return info;
      cur = cur.parent;
    }
    return null;
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  listEntities(): Entity[] {
    return [...this.entities.values()];
  }

  /** 该实体的全部可高亮网格 */
  meshesOf(entityId: string): THREE.Mesh[] {
    const entity = this.entities.get(entityId);
    if (!entity) return [];
    return entity.parts.map((p) => p.mesh);
  }

  /** 全部可交互网格，供拾取系统构建 raycast 目标集 */
  allInteractiveMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const entity of this.entities.values()) {
      for (const part of entity.parts) out.push(part.mesh);
    }
    return out;
  }

  /** 实体世界包围盒（带缓存） */
  boundsOf(entityId: string): THREE.Box3 {
    const entity = this.entities.get(entityId);
    if (!entity) return new THREE.Box3();
    if (entity.boundsDirty) {
      entity.bounds.makeEmpty();
      const tmp = new THREE.Box3();
      for (const part of entity.parts) {
        tmp.setFromObject(part.mesh);
        if (!tmp.isEmpty()) entity.bounds.union(tmp);
      }
      entity.boundsDirty = false;
    }
    return entity.bounds;
  }

  /** 实体中心点（世界坐标） */
  centerOf(entityId: string): THREE.Vector3 | null {
    const bounds = this.boundsOf(entityId);
    if (bounds.isEmpty()) return null;
    return bounds.getCenter(new THREE.Vector3());
  }

  dispose(): void {
    this.entities.clear();
    this.staticMeshes.length = 0;
  }
}
