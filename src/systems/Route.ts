import * as THREE from 'three';
import type { FrameInfo } from '../core/Loop';
import type { RoadNetwork } from './RoadNetwork';
import { nearestNode, pathToCurve } from './RoadNetwork';
import type { PlanResult, WorkerResponse } from '../workers/pathfinding.worker';

/**
 * 路径规划客户端 + 可视化。
 *
 * 三层职责分离：
 *   1. RoutePlanner：Worker 通信（不碰 3D）
 *   2. RouteVisual：把节点序列画成地面流光带（纯 3D）
 *   3. AgvFleet：沿曲线驱动 AGV 模型（动画）
 *
 * 地面流光实现：不用粒子（性能不可控），而是
 * 「一条沿曲线生成的带状几何 + 沿 UV 滚动的程序化条纹」。
 * 这样固定 2 个 drawcall，视觉上却有持续流动的方向感。
 */
export interface RouteResult {
  path: number[];
  distance: number;
  expanded: number;
  ms: number;
  curve: THREE.CatmullRomCurve3;
}

export class RoutePlanner {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: PlanResult) => void; reject: (e: Error) => void }
  >();
  private ready: Promise<void> | null = null;

  constructor(private readonly network: RoadNetwork) {}

  /** 初始化 Worker 并注入路网 */
  init(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker(new URL('../workers/pathfinding.worker.ts', import.meta.url), {
          type: 'module',
        });
      } catch (err) {
        reject(err as Error);
        return;
      }

      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          console.info(`[RoutePlanner] Worker 就绪，${msg.nodeCount} 节点`);
          resolve();
          return;
        }
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.type === 'result') entry.resolve(msg);
        else entry.reject(new Error(msg.message));
      };

      this.worker.onerror = (err) => {
        console.error('[RoutePlanner] Worker 错误', err);
        reject(new Error('路径规划 Worker 启动失败'));
      };

      this.worker.postMessage({ type: 'init', graph: this.network.graph });
    });

    return this.ready;
  }

  async plan(fromWorld: THREE.Vector3, toWorld: THREE.Vector3): Promise<RouteResult> {
    await this.init();
    if (!this.worker) throw new Error('Worker 不可用');

    const from = nearestNode(this.network, fromWorld);
    const to = nearestNode(this.network, toWorld);
    const id = this.nextId++;

    const result = await new Promise<PlanResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'plan', id, from, to });
      // 兜底超时，避免 Promise 永久挂起
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('路径规划超时'));
      }, 5000);
    });

    return {
      path: result.path,
      distance: result.distance,
      expanded: result.expanded,
      ms: result.ms,
      curve: pathToCurve(this.network, result.path),
    };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.ready = null;
  }
}

/**
 * 路径可视化：地面发光带 + 流动光点。
 *
 * 几何用 TubeGeometry 贴在 Y=0.08，避免与地面 z-fighting；
 * 材质用程序化条纹纹理 + offset 滚动，产生「光在流动」的错觉。
 * 相比沿曲线移动多个 Sprite，这是常数开销。
 */
export class RouteVisual {
  readonly group = new THREE.Group();
  private tube: THREE.Mesh | null = null;
  private flowMaterial: THREE.MeshBasicMaterial;
  private readonly flowTexture: THREE.CanvasTexture;
  private offset = 0;

  constructor() {
    this.group.name = 'ROUTE';
    this.flowTexture = makeFlowTexture();
    this.flowMaterial = new THREE.MeshBasicMaterial({
      map: this.flowTexture,
      color: 0x54e0ff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.group.visible = false;
  }

  show(curve: THREE.CatmullRomCurve3): void {
    this.clear();

    // TubeGeometry 的 tubularSegments 按曲线长度给，保证光带密度一致
    const length = curve.getLength();
    const segments = Math.max(24, Math.min(320, Math.round(length * 3)));
    const geo = new THREE.TubeGeometry(curve, segments, 0.14, 6, false);

    // 关键：把管体压扁并贴地
    const pos = geo.attributes['position'] as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i);
      pos.setY(i, Math.max(0.08, y * 0.22 + 0.08));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this.flowMaterial);
    mesh.name = 'ROUTE_tube';
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.tube = mesh;
    this.group.visible = true;

    // 起点/终点标记：用两个小圆环，明确指向
    const startRing = makeNodeRing(0x35d68a);
    const endRing = makeNodeRing(0xffb545);
    const p0 = curve.getPointAt(0);
    const p1 = curve.getPointAt(1);
    startRing.position.set(p0.x, 0.1, p0.z);
    endRing.position.set(p1.x, 0.1, p1.z);
    this.group.add(startRing, endRing);
  }

  update(frame: FrameInfo): void {
    if (!this.group.visible) return;
    // 流动方向：负向滚动 = 光点从起点流向终点
    this.offset = (this.offset + frame.delta * 1.35) % 1;
    this.flowTexture.offset.y = -this.offset;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const mesh = child as THREE.Mesh;
      if (child.userData['__ring']) {
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material)?.dispose();
      }
    }
    this.tube?.geometry.dispose();
    this.tube = null;
    this.group.visible = false;
  }

  dispose(): void {
    this.clear();
    this.flowTexture.dispose();
    this.flowMaterial.dispose();
  }
}

function makeNodeRing(color: number): THREE.Mesh {
  const geo = new THREE.RingGeometry(0.42, 0.56, 32);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.userData['__ring'] = true;
  mesh.renderOrder = 3;
  return mesh;
}

/** 条纹纹理：沿 V 方向做亮暗渐变，滚动时形成流动光带 */
function makeFlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 8, 128);

  // 多段不对称亮带 → 滚动时有「脉冲」感而不是均匀条纹
  const bands = [
    { start: 0.0, len: 0.16, alpha: 0.95 },
    { start: 0.22, len: 0.09, alpha: 0.5 },
    { start: 0.44, len: 0.2, alpha: 0.85 },
    { start: 0.72, len: 0.07, alpha: 0.35 },
  ];
  for (const b of bands) {
    const grad = ctx.createLinearGradient(0, b.start * 128, 0, (b.start + b.len) * 128);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${b.alpha})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, b.start * 128, 8, b.len * 128);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * AGV 车队：沿路径曲线行驶。
 *
 * 行驶实现要点：
 * 1. 用 curve.getPointAt(t)（弧长参数化）而不是 getPoint(t)，
 *    否则在拐角处速度会突然变化 —— 这是最容易忽略的细节；
 * 2. 朝向用切线算，并做角度插值，避免在急转弯时模型瞬间翻转；
 * 3. 到达后停在终点，并把 t 复位，便于下一次任务；
 * 4. 只驱动根节点（位移+偏航），轮子旋转由 glTF 自带动画负责。
 */
export interface AgvState {
  entityId: string;
  root: THREE.Object3D;
  curve: THREE.CatmullRomCurve3 | null;
  t: number;
  speed: number;
  moving: boolean;
  length: number;
}

export class AgvFleet {
  private readonly agvs = new Map<string, AgvState>();

  register(entityId: string, root: THREE.Object3D): void {
    this.agvs.set(entityId, {
      entityId,
      root,
      curve: null,
      t: 0,
      speed: 2.6,
      moving: false,
      length: 0,
    });
  }

  get(entityId: string): AgvState | undefined {
    return this.agvs.get(entityId);
  }

  list(): AgvState[] {
    return [...this.agvs.values()];
  }

  /** 派发任务：沿曲线行驶。不同 AGV 给不同速度，避免重叠 */
  dispatch(entityId: string, curve: THREE.CatmullRomCurve3, speed?: number): void {
    const agv = this.agvs.get(entityId);
    if (!agv) return;
    agv.curve = curve;
    agv.length = curve.getLength();
    agv.t = 0;
    agv.speed = speed ?? 2.4 + Math.random() * 0.8;
    agv.moving = true;

    // 立即放到起点，避免从旧位置「跳」过来时穿过模型
    const p = curve.getPointAt(0);
    agv.root.position.set(p.x, agv.root.position.y, p.z);
  }

  stopAll(): void {
    for (const agv of this.agvs.values()) {
      agv.moving = false;
      agv.curve = null;
    }
  }

  update(frame: FrameInfo): void {
    for (const agv of this.agvs.values()) {
      if (!agv.moving || !agv.curve) continue;

      // 弧长参数化：匀速前进
      const dt = (agv.speed * frame.delta) / Math.max(0.001, agv.length);
      agv.t = Math.min(1, agv.t + dt);

      const p = agv.curve.getPointAt(agv.t);
      agv.root.position.x = p.x;
      agv.root.position.z = p.z;

      // 朝向：用切线方向做 yaw，并做最短角插值
      const tangent = agv.curve.getTangentAt(agv.t);
      const targetYaw = Math.atan2(tangent.x, tangent.z);
      const currentYaw = agv.root.rotation.y;
      let diff = targetYaw - currentYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      agv.root.rotation.y = currentYaw + diff * Math.min(1, frame.delta * 6);

      if (agv.t >= 1) {
        agv.moving = false;
        agv.curve = null;
        agv.t = 0;
      }
    }
  }

  /** 找到离某点最近的 AGV（用于「跟随这台 AGV」） */
  nearest(position: THREE.Vector3): AgvState | null {
    let best: AgvState | null = null;
    let bestDist = Infinity;
    for (const agv of this.agvs.values()) {
      const d = agv.root.position.distanceToSquared(position);
      if (d < bestDist) {
        bestDist = d;
        best = agv;
      }
    }
    return best;
  }
}
