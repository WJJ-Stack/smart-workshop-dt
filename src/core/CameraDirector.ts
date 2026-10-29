import * as THREE from 'three';
import type { FrameInfo } from '../core/Loop';
import type { CameraRig } from '../core/CameraRig';

/**
 * 相机导演：负责「跟随」这类需要每帧持续写入相机状态的模式。
 *
 * 跟随为什么单独做：
 * OrbitControls 的 target 是固定点，而跟随的目标在移动，
 * 如果每帧把 target 设为目标当前位置，相机会「粘」在物体上，
 * 用户再也无法手动调整视角（控制器每帧被覆盖）。
 *
 * 正确做法：跟随不是「覆盖」，而是「保持相对位姿的偏移」。
 * 这里记录用户手动调整后的相对偏移，每帧把相机放到
 * target + offset（offset 随目标朝向旋转），并允许用户在跟随中继续旋转观察。
 */
export interface FollowOptions {
  rig: CameraRig;
  /** 相对目标的偏移（目标局部坐标系） */
  offset?: THREE.Vector3;
  /** 平滑系数，越大越紧跟 */
  damping?: number;
}

export class FollowDirector {
  enabled = false;

  private readonly rig: CameraRig;
  private readonly damping: number;
  private offset: THREE.Vector3;

  private target: THREE.Object3D | null = null;
  private readonly lastTargetPos = new THREE.Vector3();
  private readonly lastCameraPos = new THREE.Vector3();
  private initialized = false;

  constructor(opts: FollowOptions) {
    this.rig = opts.rig;
    this.damping = opts.damping ?? 4.5;
    this.offset = (opts.offset ?? new THREE.Vector3(3.2, 2.1, 3.2)).clone();
  }

  get following(): THREE.Object3D | null {
    return this.target;
  }

  follow(target: THREE.Object3D, offset?: THREE.Vector3): void {
    this.target = target;
    if (offset) this.offset.copy(offset);
    this.initialized = false;
    this.enabled = true;
  }

  stop(): void {
    this.enabled = false;
    this.target = null;
    this.initialized = false;
  }

  /**
   * 每帧更新。返回 true 表示本帧相机由跟随接管。
   * 相机过渡进行中时让位（例如点设备卡触发 flyTo）。
   */
  update(delta: number): boolean {
    if (!this.enabled || !this.target) return false;
    if (this.rig.transition.active) return false;

    const targetPos = this.target.getWorldPosition(new THREE.Vector3());

    if (!this.initialized) {
      // 首帧：保留用户当前相对位姿，避免相机瞬移
      const camPos = this.rig.camera.position.clone();
      this.offset.copy(camPos).sub(targetPos);
      this.lastTargetPos.copy(targetPos);
      this.lastCameraPos.copy(camPos);
      this.initialized = true;
      return true;
    }

    // 用户在跟随中手动旋转了相机 → 更新偏移，让新的视角被保留
    const camPos = this.rig.camera.position;
    const userMoved = camPos.distanceTo(this.lastCameraPos) > 0.02;
    if (userMoved) {
      this.offset.copy(camPos).sub(this.lastTargetPos);
    }

    // 目标移动了多少，相机就跟着移动多少（保持相对偏移）
    const desired = targetPos.clone().add(this.offset);
    const t = 1 - Math.exp(-this.damping * delta);
    camPos.lerp(desired, t);

    // 注视点也平滑跟随，避免相机「甩」
    this.rig.target.lerp(targetPos, Math.min(1, t * 1.6));

    this.lastTargetPos.copy(targetPos);
    this.lastCameraPos.copy(camPos);
    return true;
  }

  dispose(): void {
    this.stop();
  }
}

/**
 * 场景层级切换（厂区 ↔ 车间）。
 *
 * 需求来源：JD 里的「地图融合」与「多层级场景」。
 * 纯前端实现时不需要真正的 GIS，需要的是：
 *   1. 两套相机尺度与运动参数；
 *   2. 过渡时隐藏/显示的层级控制（屋面要不要掀掉、外墙要不要透明）；
 *   3. 统一的世界坐标 —— 这点最容易做错，如果两层各用各的原点，
 *      下钻后模型会漂移。
 * 这里两层共享同一世界坐标，只切换「可见性 + 相机参数」。
 */
export type SceneLevel = 'site' | 'hall';

export interface LevelConfig {
  level: SceneLevel;
  /** 相机最近/最远距离 */
  minDistance: number;
  maxDistance: number;
  /** 相机移动速度 */
  flySpeed: number;
  /** 是否隐藏屋面（进入车间内部时必须隐藏，否则看不到里面） */
  hideRoof: boolean;
  /** 环境雾密度 */
  fogDensity: number;
}

const LEVELS: Record<SceneLevel, Omit<LevelConfig, 'level'>> = {
  site: {
    minDistance: 12,
    maxDistance: 420,
    flySpeed: 22,
    hideRoof: false,
    fogDensity: 0.0016,
  },
  hall: {
    minDistance: 2.5,
    maxDistance: 90,
    flySpeed: 9,
    hideRoof: true,
    fogDensity: 0.0055,
  },
};

export class LevelManager {
  private current: SceneLevel = 'site';
  private readonly roofObjects: THREE.Object3D[] = [];
  private readonly wallObjects: THREE.Object3D[] = [];
  private readonly listeners = new Set<(level: SceneLevel, config: LevelConfig) => void>();

  constructor(sceneRoot: THREE.Object3D) {
    // 按命名收集需要随层级切换显隐的对象
    sceneRoot.traverse((obj) => {
      const n = obj.name;
      if (n.startsWith('ENV_roof') || n.includes('truss') || n.includes('purlin') || n.includes('lamp')) {
        this.roofObjects.push(obj);
      }
      if (n.startsWith('ENV_wall')) {
        this.wallObjects.push(obj);
      }
      if (n.startsWith('MERGED_env_RoofMetal')) {
        this.roofObjects.push(obj);
      }
    });
    console.info(
      `[LevelManager] 屋面/桁架/灯具 ${this.roofObjects.length} 个，墙体 ${this.wallObjects.length} 个`,
    );
  }

  get level(): SceneLevel {
    return this.current;
  }

  currentConfig(): LevelConfig {
    return { level: this.current, ...LEVELS[this.current] };
  }

  configOf(level: SceneLevel): LevelConfig {
    return { level, ...LEVELS[level] };
  }

  onChange(fn: (level: SceneLevel, config: LevelConfig) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setLevel(level: SceneLevel): LevelConfig {
    this.current = level;
    const config = this.currentConfig();

    for (const obj of this.roofObjects) {
      obj.visible = !config.hideRoof;
    }
    // 进入车间时墙体保留（提供空间围合感），但外部视角下也保留 —— 无操作
    void this.wallObjects;

    for (const fn of this.listeners) fn(level, config);
    return config;
  }

  /** 自动判级：根据相机到场景中心的水平距离推断当前层级 */
  inferLevel(cameraPos: THREE.Vector3, hall: { length: number; width: number }): SceneLevel {
    const dx = Math.abs(cameraPos.x);
    const dz = Math.abs(cameraPos.z);
    const inside = dx < hall.length * 0.52 && dz < hall.width * 0.52;
    return inside ? 'hall' : 'site';
  }

  dispose(): void {
    this.roofObjects.length = 0;
    this.wallObjects.length = 0;
    this.listeners.clear();
  }
}

/**
 * 相机模式统一调度器。
 *
 * 三种模式互斥：orbit（观察）/ fly（走查）/ follow（跟随）。
 * 用一个「单一真相」的状态机来切换，而不是散落的布尔标志 ——
 * 否则很容易出现「飞行中还能用 Orbit」这类 bug。
 */
export type CameraMode = 'orbit' | 'fly' | 'follow';

export interface CameraModeChange {
  mode: CameraMode;
  prev: CameraMode;
}

export class CameraModeController {
  private mode: CameraMode = 'orbit';
  private readonly listeners = new Set<(e: CameraModeChange) => void>();

  constructor(
    private readonly deps: {
      orbit: { setEnabled(v: boolean): void };
      fly: { enter(): void; exit(): void };
      follow: { stop(): void };
    },
  ) {}

  get current(): CameraMode {
    return this.mode;
  }

  onChange(fn: (e: CameraModeChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(mode: CameraMode): void {
    if (mode === this.mode) return;
    const prev = this.mode;

    // 先全部退出，再进入目标模式 —— 顺序反了会导致控制器互相覆盖
    this.deps.fly.exit();
    this.deps.follow.stop();
    this.deps.orbit.setEnabled(false);

    switch (mode) {
      case 'orbit':
        this.deps.orbit.setEnabled(true);
        break;
      case 'fly':
        this.deps.fly.enter();
        break;
      case 'follow':
        // 跟随由 FollowDirector 单独接管，Orbit 保持禁用
        break;
      default:
        break;
    }

    this.mode = mode;
    for (const fn of this.listeners) fn({ mode, prev });
  }

  dispose(): void {
    this.listeners.clear();
  }
}

void (undefined as unknown as FrameInfo);
