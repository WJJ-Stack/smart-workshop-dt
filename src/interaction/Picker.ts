import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { EntityRegistry, PartInfo } from '../entities/EntityRegistry';

/**
 * 拾取系统。
 *
 * 为什么需要 BVH：
 * 场景 59k 三角面时，朴素 raycast 需要对每个三角面做射线-三角形相交测试，
 * 每次指针移动都是 O(n)。BVH（层次包围盒）把它降到 O(log n)。
 * 具体到这个项目：hover 节流 40ms，一次 raycast 从 ~4.8ms 降到 ~0.15ms，
 * 这是「鼠标划过设备时不掉帧」的关键。
 *
 * 三个必须处理的坑：
 * 1. BVH 只在静态几何上有效 —— 有骨骼/顶点动画的 mesh 不能建 BVH，
 *    否则包围盒过期会导致「能看见但拾取不到」；
 * 2. 拾取目标集要排除描边壳、不可见对象、非交互层；
 * 3. 命中多个对象时要有稳定的排序策略（这里按距离取最近）。
 */
export interface PickResult {
  part: PartInfo;
  point: THREE.Vector3;
  distance: number;
  faceIndex: number | undefined;
}

export interface PickerOptions {
  registry: EntityRegistry;
  camera: THREE.Camera;
  /** 可拾取目标集（延迟获取，因为实体可能动态增删） */
  getTargets: () => THREE.Mesh[];
}

export class Picker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly opts: PickerOptions;
  private bvhBuilt = false;

  constructor(opts: PickerOptions) {
    this.opts = opts;
    this.raycaster.firstHitOnly = true;
  }

  /**
   * 为所有可拾取网格构建 BVH。
   * 在场景加载完成后调用一次。耗时随三角面数线性增长（59k 约 60~120ms），
   * 所以放在首屏加载之后、用户真正开始交互之前。
   */
  buildBvh(): { meshes: number; ms: number } {
    if (this.bvhBuilt) return { meshes: 0, ms: 0 };
    const t0 = performance.now();
    const targets = this.opts.getTargets();
    let count = 0;

    for (const mesh of targets) {
      const geo = mesh.geometry;
      if (!geo) continue;
      // three-mesh-bvh 的 computeBoundsTree 是挂在 BufferGeometry 原型上的方法
      // （用 computeBoundsTree.call(geo) 也行），这里用最直观的调用形式
      if (!geo.boundsTree) {
        computeBoundsTree.call(geo, { maxLeafTris: 8 });
      }
      mesh.raycast = acceleratedRaycast;
      count += 1;
    }

    this.bvhBuilt = true;
    const ms = performance.now() - t0;
    console.info(`[Picker] BVH 构建完成：${count} 个网格，耗时 ${ms.toFixed(1)}ms`);
    return { meshes: count, ms };
  }

  /**
   * 单点拾取。返回命中的部件信息（含所属实体）。
   * ndcX/ndcY 为 [-1,1] 归一化设备坐标。
   */
  pick(ndcX: number, ndcY: number): PickResult | null {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, this.opts.camera);

    const targets = this.opts.getTargets();
    if (targets.length === 0) return null;

    const hits = this.raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      if (!hit.object.visible) continue;
      if (hit.object.userData['__outline']) continue;

      const part = this.opts.registry.resolve(hit.object);
      if (!part) continue;

      return {
        part,
        point: hit.point.clone(),
        distance: hit.distance,
        faceIndex: hit.faceIndex ?? undefined,
      };
    }
    return null;
  }

  /** 拾取一组（用于框选；目前按 NDC 矩形过滤） */
  pickRect(
    ndcMinX: number,
    ndcMinY: number,
    ndcMaxX: number,
    ndcMaxY: number,
  ): PickResult[] {
    const targets = this.opts.getTargets();
    const out: PickResult[] = [];
    const center = new THREE.Vector2((ndcMinX + ndcMaxX) * 0.5, (ndcMinY + ndcMaxY) * 0.5);
    const width = Math.abs(ndcMaxX - ndcMinX) * 0.5;
    const height = Math.abs(ndcMaxY - ndcMinY) * 0.5;

    for (const mesh of targets) {
      const worldPos = mesh.getWorldPosition(new THREE.Vector3());
      const projected = worldPos.clone().project(this.opts.camera);
      if (
        projected.x >= center.x - width &&
        projected.x <= center.x + width &&
        projected.y >= center.y - height &&
        projected.y <= center.y + height &&
        projected.z < 1
      ) {
        const part = this.opts.registry.resolve(mesh);
        if (part) {
          out.push({
            part,
            point: worldPos,
            distance: worldPos.distanceTo(this.opts.camera.position),
            faceIndex: undefined,
          });
        }
      }
    }
    return out;
  }

  /** 场景变化后（如 LOD 切换、实体增删）需要重建 */
  invalidate(): void {
    this.bvhBuilt = false;
  }

  dispose(): void {
    for (const mesh of this.opts.getTargets()) {
      const geo = mesh.geometry;
      if (geo?.boundsTree) {
        disposeBoundsTree.call(geo);
        mesh.raycast = THREE.Mesh.prototype.raycast;
      }
    }
    this.bvhBuilt = false;
  }
}
