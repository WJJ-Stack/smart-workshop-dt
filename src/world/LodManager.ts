import * as THREE from 'three';
import type { FrameInfo } from '../core/Loop';
import type { QualityProfile } from '../core/quality';
import type { AssetManifest, LodEntry } from '../assets/manifest';
import type { AssetManager } from '../assets/AssetManager';

/**
 * LOD 管理器：按相机距离在多份 GLB 之间切换。
 *
 * 为什么不用 three.LOD：
 * three.LOD 要求把三份模型都加载进内存并挂成子树，
 * 对我们的场景（LOD0 590KB + LOD1 550KB + LOD2 320KB）意味着
 * 首屏就要下载 1.46MB，且常驻显存。而实际需求是「远处只看个轮廓」。
 *
 * 自定义实现的做法：
 * - 首屏只加载 LOD0；
 * - 相机远离到阈值时**按需**加载更粗的 LOD，并替换原模型；
 * - 近回时切回更精细的 LOD（若已加载则秒切，否则等待）；
 * - 用「滞回区间」避免在阈值附近反复横跳（这是 LOD 抖动的主因）。
 *
 * 代价：实体注册表需要重建索引（因为换成另一份模型了）。
 * 这里通过回调通知外部重绑，而不是让 LOD 管理器去理解实体语义。
 */
export interface LodManagerOptions {
  scene: THREE.Scene;
  baseUrl: string;
  manifest: AssetManifest;
  assets: AssetManager;
  /** 根容器，旧模型从这里移除、新模型加进来 */
  container: THREE.Group;
  /** LOD 切换完成后回调（外部需要重新索引实体） */
  onSwitched?: (level: number) => void;
  /** 当前使用的 LOD */
  initialLevel?: number;
}

interface LodState {
  level: number;
  root: THREE.Object3D | null;
  loaded: boolean;
  loading: boolean;
}

const HYSTERESIS = 0.18;

export class LodManager {
  private readonly opts: LodManagerOptions;
  private readonly states: LodState[] = [];
  private current: number;
  private target: number;
  private enabled = true;
  private switchCooldown = 0;
  /** 统计：切换次数与耗时，供 PERF.md 引用 */
  readonly stats = { switches: 0, loadMs: 0, skipped: 0 };

  constructor(opts: LodManagerOptions) {
    this.opts = opts;
    this.current = opts.initialLevel ?? 0;
    this.target = this.current;

    const sorted = [...opts.manifest.lods].sort((a, b) => a.level - b.level);
    for (const entry of sorted) {
      this.states.push({
        level: entry.level,
        root: entry.level === this.current ? opts.container.children[0] ?? null : null,
        loaded: entry.level === this.current,
        loading: false,
      });
    }
  }

  get level(): number {
    return this.current;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.current !== 0) {
      // 关闭 LOD 时回到最高精度
      void this.switchTo(0);
    }
  }

  /**
   * 每帧评估该用哪一级。
   * cameraDistance 用「相机到场景中心」而不是到每个物体：
   * 我们的场景是一整栋厂房，逐物体 LOD 的收益不如整场景切换明显，
   * 且整场景切换只需一次模型替换，实现与维护成本都低得多。
   */
  update(frame: FrameInfo, cameraPos: THREE.Vector3, sceneCenter: THREE.Vector3): void {
    if (!this.enabled) return;
    if (this.switchCooldown > 0) {
      this.switchCooldown -= frame.delta;
      if (this.switchCooldown > 0) return;
    }

    const distance = cameraPos.distanceTo(sceneCenter);
    const desired = this.levelForDistance(distance);

    if (desired === this.target) return;
    this.target = desired;
    void this.switchTo(desired);
  }

  /** 滞回：升级阈值比降级阈值略高，避免边界抖动 */
  private levelForDistance(distance: number): number {
    const lods: LodEntry[] = [...this.opts.manifest.lods].sort((a, b) => a.level - b.level);
    let chosen = 0;
    for (const lod of lods) {
      if (lod.level === 0) continue;
      const threshold = lod.maxDistance;
      // 当前已经是这一级时，要求距离超过阈值*(1+滞回) 才降级
      const adjusted = this.current === lod.level ? threshold * (1 + HYSTERESIS) : threshold;
      if (distance > adjusted) chosen = Math.max(chosen, lod.level);
    }
    return chosen;
  }

  private async switchTo(level: number): Promise<void> {
    if (level === this.current) return;
    const state = this.states.find((s) => s.level === level);
    if (!state) return;

    // 正在加载同一级则不重复触发
    if (state.loading) return;

    if (!state.loaded) {
      state.loading = true;
      const entry = this.opts.manifest.lods.find((l) => l.level === level);
      if (!entry) {
        state.loading = false;
        return;
      }
      const t0 = performance.now();
      try {
        const gltf = await this.opts.assets.loadGltf(`${this.opts.baseUrl}${entry.file}`);
        state.root = gltf.scene;
        state.root.name = `WORKSHOP_MODEL_LOD${level}`;
        state.loaded = true;
        this.stats.loadMs = performance.now() - t0;
      } catch (err) {
        console.warn(`[LodManager] LOD${level} 加载失败，保持当前级别`, err);
        state.loading = false;
        // 加载失败就不再尝试这一级，避免反复请求
        this.enabled = false;
        return;
      }
      state.loading = false;
    }

    if (!state.root) return;

    // 替换模型：移除旧的、加入新的
    const prevState = this.states.find((s) => s.level === this.current);
    if (prevState?.root) prevState.root.removeFromParent();
    this.opts.container.add(state.root);

    this.current = level;
    this.stats.switches += 1;
    // 切换后短暂冷却，避免相机轻微抖动立刻又切回去
    this.switchCooldown = 0.35;

    console.info(
      `[LodManager] 切换到 LOD${level}` +
        (this.stats.loadMs > 0 ? `（加载 ${this.stats.loadMs.toFixed(0)}ms）` : '（已缓存）'),
    );
    this.opts.onSwitched?.(level);
  }

  /** 预加载某一级（例如首屏完成后后台预取 LOD1，让首次切换无感） */
  prefetch(level: number): void {
    const state = this.states.find((s) => s.level === level);
    if (!state || state.loaded || state.loading) return;
    const entry = this.opts.manifest.lods.find((l) => l.level === level);
    if (!entry) return;

    state.loading = true;
    void this.opts.assets
      .loadGltf(`${this.opts.baseUrl}${entry.file}`)
      .then((gltf) => {
        state.root = gltf.scene;
        state.root.name = `WORKSHOP_MODEL_LOD${level}`;
        state.loaded = true;
        console.info(`[LodManager] LOD${level} 预加载完成`);
      })
      .catch((err) => console.warn(`[LodManager] LOD${level} 预加载失败`, err))
      .finally(() => {
        state.loading = false;
      });
  }

  dispose(): void {
    for (const state of this.states) {
      if (state.root && state.level !== this.current) {
        state.root.removeFromParent();
      }
    }
    this.states.length = 0;
  }
}

/** 计算场景中心与尺寸，供 LOD 与相机使用 */
export function sceneMetrics(root: THREE.Object3D): {
  center: THREE.Vector3;
  size: THREE.Vector3;
  radius: number;
} {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    return { center: new THREE.Vector3(), size: new THREE.Vector3(), radius: 1 };
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return { center, size, radius: size.length() * 0.5 };
}

/**
 * 视锥剔除统计。
 *
 * three.js 默认对每个 Object3D 做视锥测试，但我们需要量化「剔除了多少」，
 * 才能在 PERF.md 里给出可信数字。这里通过一次手动遍历统计，
 * 采样频率很低（每秒一次），不影响帧率。
 */
export interface CullStats {
  total: number;
  visible: number;
  culled: number;
  culledRatio: number;
}

export function measureCulling(
  root: THREE.Object3D,
  camera: THREE.Camera,
): CullStats {
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);

  let total = 0;
  let visible = 0;
  const sphere = new THREE.Sphere();
  const box = new THREE.Box3();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !obj.visible) return;
    total += 1;

    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const bs = mesh.geometry.boundingSphere;
    if (!bs) return;

    sphere.copy(bs).applyMatrix4(mesh.matrixWorld);
    if (frustum.intersectsSphere(sphere)) visible += 1;
    void box;
  });

  const culled = total - visible;
  return { total, visible, culled, culledRatio: total > 0 ? culled / total : 0 };
}

export function qualityAllowsLod(profile: QualityProfile): boolean {
  // low 档直接用最粗的 LOD，以帧率为第一优先
  return profile.tier !== 'low';
}
