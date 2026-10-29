import * as THREE from 'three';

/**
 * 相机装配：一个透视相机 + 一个 CameraDirector 负责平滑过渡。
 *
 * 为什么不用多个相机：
 * 切换相机需要维护 up 向量、视锥、后处理绑定，成本高且容易出 bug。
 * 单相机 + 位姿插值（position/quaternion/target）更稳定，过渡也更自然。
 */
export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov?: number;
  /** 过渡时长（秒），0 表示瞬时 */
  duration?: number;
  /** 缓动函数，默认 easeInOutCubic */
  ease?: (t: number) => number;
}

export const eases = {
  linear: (t: number): number => t,
  easeInOutCubic: (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeOutCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  easeOutExpo: (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInOutQuint: (t: number): number =>
    t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2,
} as const;

export interface CameraTransition {
  active: boolean;
  progress: number;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** 相机注视点，Orbit 控制器直接读写 */
  readonly target = new THREE.Vector3(0, 0, 0);

  private from = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 50 };
  private to = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 50 };
  private duration = 0;
  private elapsed = 0;
  private ease: (t: number) => number = eases.easeInOutCubic;
  private transitioning = false;
  private onComplete: (() => void) | undefined;

  /** 过渡期间外部控制器应暂停输入 */
  readonly transition: CameraTransition = { active: false, progress: 0 };

  constructor(initial: CameraPose) {
    this.camera = new THREE.PerspectiveCamera(initial.fov ?? 50, 1, 0.1, 4000);
    this.camera.position.copy(initial.position);
    this.target.copy(initial.target);
    this.camera.lookAt(this.target);
    // 记录到 from/to，避免首帧状态不一致
    this.to.position.copy(initial.position);
    this.to.target.copy(initial.target);
    this.to.fov = initial.fov ?? 50;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 平滑飞向目标位姿。若正在过渡，则以当前状态为新起点重新插值，
   * 避免打断后跳变（这是用户最容易感知到的体验问题）。
   */
  flyTo(pose: CameraPose, onComplete?: () => void): void {
    this.from.position.copy(this.camera.position);
    this.from.target.copy(this.target);
    this.from.fov = this.camera.fov;

    this.to.position.copy(pose.position);
    this.to.target.copy(pose.target);
    this.to.fov = pose.fov ?? this.camera.fov;

    this.duration = Math.max(0, pose.duration ?? 1.2);
    this.ease = pose.ease ?? eases.easeInOutCubic;
    this.elapsed = 0;
    this.onComplete = onComplete;

    if (this.duration === 0) {
      this.snapTo(pose);
      onComplete?.();
      return;
    }
    this.transitioning = true;
    this.transition.active = true;
  }

  snapTo(pose: CameraPose): void {
    this.camera.position.copy(pose.position);
    this.target.copy(pose.target);
    if (pose.fov !== undefined) {
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.lookAt(this.target);
    this.transitioning = false;
    this.transition.active = false;
    this.transition.progress = 1;
  }

  cancelTransition(): void {
    if (!this.transitioning) return;
    this.transitioning = false;
    this.transition.active = false;
  }

  /**
   * 由 Loop 驱动。返回 true 表示本帧相机位姿已被接管（控制器应跳过更新）。
   */
  update(delta: number): boolean {
    if (this.transitioning) {
      this.elapsed += delta;
      const raw = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
      const t = this.ease(raw);
      this.transition.progress = raw;

      this.camera.position.lerpVectors(this.from.position, this.to.position, t);
      this.target.lerpVectors(this.from.target, this.to.target, t);
      const fov = THREE.MathUtils.lerp(this.from.fov, this.to.fov, t);
      if (Math.abs(fov - this.camera.fov) > 1e-3) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      this.camera.lookAt(this.target);

      if (raw >= 1) {
        this.transitioning = false;
        this.transition.active = false;
        const cb = this.onComplete;
        this.onComplete = undefined;
        cb?.();
      }
      return true;
    }

    // 空闲时由控制器写 camera.position + target，这里只负责朝向对齐
    this.camera.lookAt(this.target);
    return false;
  }

  /** 当前位姿快照，用于调试与「回到上一机位」 */
  capturePose(): CameraPose {
    return {
      position: this.camera.position.clone(),
      target: this.target.clone(),
      fov: this.camera.fov,
    };
  }
}
