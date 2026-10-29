import * as THREE from 'three';
import { OrbitControl } from './core/OrbitControl';
import { FlyControl } from './core/FlyControl';
import { FollowDirector, CameraModeController } from './core/CameraDirector';
import { CameraRig, type CameraPose } from './core/CameraRig';
import { Loop, type FrameInfo } from './core/Loop';
import { PointerInput } from './core/PointerInput';
import { Renderer } from './core/Renderer';
import { Viewport } from './core/Viewport';
import { detectQualityTier, lowerTier, resolveProfile, type QualityProfile, type QualityTier } from './core/quality';
import { EventBus } from './shared/EventBus';
import type { AppEvents } from './shared/events';

/**
 * App 是世界（3D 内容）与运行时（渲染器/循环/输入）之间的组合根。
 *
 * 职责边界：
 * - App 只负责「装配与生命周期」，不写任何具体业务；
 * - 业务以 World 接口注入（M2 之后逐步实现）；
 * - 所有可释放资源通过 registerDisposable 登记，保证严格逆序销毁。
 */

export interface WorldContext {
  app: App;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: Renderer;
  rig: CameraRig;
  bus: EventBus<AppEvents>;
  quality: QualityProfile;
}

export interface World {
  /** 场景内容构建（可为异步，加载进度由 world 自己上报） */
  build(ctx: WorldContext): Promise<void>;
  /** 每帧更新，delta 已钳制 */
  update(frame: FrameInfo): void;
  /** 画质切换时需要重建的资源 */
  onQualityChange?(profile: QualityProfile): void;
  dispose(): void;
}

export interface AppOptions {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  tier?: QualityTier;
  initialPose?: CameraPose;
}

const DEFAULT_POSE: CameraPose = {
  position: new THREE.Vector3(26, 18, 30),
  target: new THREE.Vector3(0, 2, 0),
  fov: 45,
};

export class App {
  readonly scene = new THREE.Scene();
  readonly bus = new EventBus<AppEvents>();
  readonly rig: CameraRig;
  readonly renderer: Renderer;
  readonly viewport: Viewport;
  readonly loop = new Loop();
  readonly input: PointerInput;
  readonly orbit: OrbitControl;
  readonly fly: FlyControl;
  readonly follow: FollowDirector;
  readonly cameraMode: CameraModeController;

  private world: World | null = null;
  private profile: QualityProfile;
  private readonly disposables: Array<() => void> = [];
  private readonly unsubscribers: Array<() => void> = [];
  private lowFpsStreak = 0;
  private degraded = false;

  constructor(opts: AppOptions) {
    const tier = opts.tier ?? detectQualityTier();

    this.viewport = new Viewport({
      canvas: opts.canvas,
      maxPixelRatio: 2,
      adaptive: true,
    });

    // 先用 high 探测能力，再按需降到实际档位（anisotropy 依赖上下文）
    const prelim = new Renderer(this.viewport, resolveProfile('high', 8));
    const anisotropy = prelim.capabilities.maxAnisotropy;
    this.profile = resolveProfile(tier, anisotropy);
    prelim.setProfile(this.profile);
    prelim.applyViewport();
    this.renderer = prelim;

    this.viewport.setMaxPixelRatio(this.profile.maxPixelRatio);
    this.viewport.flush();
    this.renderer.applyViewport();

    this.rig = new CameraRig(opts.initialPose ?? DEFAULT_POSE);
    this.rig.setAspect(this.viewport.current.aspect);

    this.scene.matrixWorldAutoUpdate = true;
    this.scene.background = new THREE.Color(0x070b12);
    this.scene.fog = new THREE.Fog(0x070b12, 120, 460);

    this.unsubscribers.push(
      this.viewport.onChange((m) => {
        this.renderer.applyViewport();
        this.rig.setAspect(m.aspect);
        this.bus.emit('resize', { width: m.width, height: m.height, pixelRatio: m.pixelRatio });
      }),
    );

    this.input = new PointerInput(opts.canvas);
    this.input.setHoverEnabled(!isTouch());

    this.orbit = new OrbitControl({
      domElement: opts.canvas,
      camera: this.rig.camera,
      rig: this.rig,
      minDistance: 4,
      maxDistance: 620,
      maxPolarAngleDeg: 87,
    });

    this.fly = new FlyControl({
      domElement: opts.canvas,
      camera: this.rig.camera,
      rig: this.rig,
      speed: 9,
      bounds: {
        min: new THREE.Vector3(-220, 0.6, -220),
        max: new THREE.Vector3(220, 90, 220),
      },
    });

    this.follow = new FollowDirector({ rig: this.rig });
    this.cameraMode = new CameraModeController({
      orbit: { setEnabled: (v) => this.orbit.setEnabled(v) },
      fly: { enter: () => this.fly.enter(), exit: () => this.fly.exit() },
      follow: { stop: () => this.follow.stop() },
    });

    // 用户手动操作时打断相机飞行
    this.unsubscribers.push(this.input.onDown(() => {
      if (this.cameraMode.current === 'orbit') this.rig.cancelTransition();
    }));

    this.loop.add((f) => this.tick(f), 0);
  }

  get quality(): QualityProfile {
    return this.profile;
  }

  get currentWorld(): World | null {
    return this.world;
  }

  get context(): WorldContext {
    return {
      app: this,
      scene: this.scene,
      camera: this.rig.camera,
      renderer: this.renderer,
      rig: this.rig,
      bus: this.bus,
      quality: this.profile,
    };
  }

  async mount(world: World): Promise<void> {
    if (this.world) {
      this.world.dispose();
      this.world = null;
    }
    this.world = world;
    await world.build(this.context);
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  flyTo(pose: CameraPose, onComplete?: () => void): void {
    // 相机飞行时强制回到 orbit 模式，否则 fly/follow 会在飞行结束后抢走相机
    if (this.cameraMode.current !== 'orbit') this.cameraMode.set('orbit');
    this.bus.emit('camera:transition:start', { to: pose });
    this.rig.flyTo(pose, () => {
      this.orbit.syncFromRig();
      this.bus.emit('camera:transition:end', {});
      onComplete?.();
    });
  }

  /** 切换相机模式 */
  setCameraMode(mode: 'orbit' | 'fly' | 'follow'): void {
    this.cameraMode.set(mode);
  }

  /** 跟随某个对象 */
  followObject(object: THREE.Object3D): void {
    this.cameraMode.set('follow');
    this.follow.follow(object);
  }

  setQuality(tier: QualityTier): void {
    this.profile = resolveProfile(tier, this.renderer.capabilities.maxAnisotropy);
    this.renderer.setProfile(this.profile);
    this.viewport.setMaxPixelRatio(this.profile.maxPixelRatio);
    this.world?.onQualityChange?.(this.profile);
    this.bus.emit('quality:changed', { profile: this.profile });
  }
  setAdaptiveQuality(enabled: boolean): void {
    this.viewport.enableAdaptive(enabled);
    if (!enabled) this.viewport.setPixelRatioScale(1);
  }

  registerDisposable(fn: () => void): void {
    this.disposables.push(fn);
  }

  dispose(): void {
    this.loop.stop();
    this.world?.dispose();
    this.world = null;
    for (const fn of this.unsubscribers) fn();
    this.unsubscribers.length = 0;
    for (const fn of this.disposables.reverse()) fn();
    this.disposables.length = 0;
    this.cameraMode.dispose();
    this.follow.dispose();
    this.fly.dispose();
    this.orbit.dispose();
    this.input.dispose();
    this.viewport.dispose();
    this.renderer.dispose();
    this.bus.clear();
  }

  private tick(frame: FrameInfo): void {
    const transitioned = this.rig.update(frame.delta);
    if (!transitioned) {
      // 相机模式互斥，由各自的控制器决定谁写 camera.position
      const flyTook = this.fly.update(frame.delta);
      const followTook = flyTook ? false : this.follow.update(frame.delta);
      if (!flyTook && !followTook) this.orbit.update();
    }

    this.world?.update(frame);
    this.renderer.render(this.scene, this.rig.camera);
    this.guardPerformance();
  }

  /**
   * 自适应降级：连续 90 帧掉到 42fps 以下 → 降像素比；仍不行 → 降档位。
   * 只降不升，避免在临界点反复横跳（画质抖动的观感比低画质更糟）。
   */
  private guardPerformance(): void {
    if (this.degraded) return;
    const fps = this.loop.stats.fps;
    if (fps > 0 && fps < 42) {
      this.lowFpsStreak += 1;
      if (this.lowFpsStreak > 90) {
        if (this.viewport.ratio > 1.05) {
          this.viewport.setPixelRatioScale(0.75);
        } else if (this.profile.tier !== 'low') {
          this.setQuality(lowerTier(this.profile.tier));
        } else {
          this.degraded = true;
        }
        this.lowFpsStreak = 0;
      }
    } else {
      this.lowFpsStreak = Math.max(0, this.lowFpsStreak - 1);
    }
  }
}

function isTouch(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? 'ontouchstart' in window;
}
