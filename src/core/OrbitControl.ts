import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraRig } from './CameraRig';

/**
 * 轨道控制器封装。
 *
 * 相比直接 new OrbitControls，这里多做了三件事：
 * 1. 与 CameraRig 的过渡互斥：飞行过程中禁用阻尼输入，结束后把 target 同步回来；
 * 2. 统一的灵敏度/限制策略，移动端与桌面端不同；
 * 3. dispose 全量解绑，避免热重载残留监听。
 */
export interface OrbitOptions {
  domElement: HTMLElement;
  camera: THREE.Camera;
  rig: CameraRig;
  enablePan?: boolean;
  minDistance?: number;
  maxDistance?: number;
  maxPolarAngleDeg?: number;
  rotateSpeed?: number;
  dampingFactor?: number;
  autoRotate?: boolean;
}

export class OrbitControl {
  readonly controls: OrbitControls;
  private readonly rig: CameraRig;

  constructor(opts: OrbitOptions) {
    this.rig = opts.rig;

    this.controls = new OrbitControls(opts.camera, opts.domElement);
    this.controls.target.copy(opts.rig.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = opts.dampingFactor ?? 0.08;
    this.controls.enablePan = opts.enablePan ?? true;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = opts.minDistance ?? 3;
    this.controls.maxDistance = opts.maxDistance ?? 800;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(opts.maxPolarAngleDeg ?? 88);
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(6);
    this.controls.rotateSpeed = opts.rotateSpeed ?? 0.85;
    this.controls.zoomSpeed = 1.1;
    this.controls.panSpeed = 0.9;
    this.controls.autoRotate = opts.autoRotate ?? false;
    this.controls.autoRotateSpeed = 0.35;
    // 让平移按屏幕比例缩放，远距离时不至于一下飞出去
    this.controls.zoomToCursor = true;
    this.controls.update();
  }

  get enabled(): boolean {
    return this.controls.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
  }

  /**
   * 每帧调用。返回 true 表示控制器处理了输入（用于判断是否需要打断相机飞行）。
   */
  update(): void {
    // 飞行期间：禁用控制器并从 rig 同步 target，确保飞行结束不会跳
    if (this.rig.transition.active) {
      if (this.controls.enabled) this.controls.enabled = false;
      this.controls.target.copy(this.rig.target);
      return;
    }
    if (!this.controls.enabled) this.controls.enabled = true;

    this.controls.update();
    // 控制器改的是 target，回写给 rig
    this.rig.target.copy(this.controls.target);
  }

  /** 相机被程序改写后（如 snapTo），需要把 target 反向同步给控制器 */
  syncFromRig(): void {
    this.controls.target.copy(this.rig.target);
    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }
}
