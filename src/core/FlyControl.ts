import * as THREE from 'three';
import type { CameraRig } from './CameraRig';

/**
 * 第一人称飞行漫游（WASD + 鼠标视角）。
 *
 * 与 OrbitControls 的关键差异：
 * - Orbit 是「绕着一个点转」，适合观察设备；
 * - Fly 是「相机自己移动」，适合走查厂房、找问题。
 *
 * 两者必须互斥切换，否则会同时写 camera.position，产生抖动。
 *
 * 实现要点：
 * 1. 用 yaw/pitch 而不是直接改 camera.rotation，避免万向节锁与滚转漂移；
 * 2. 速度带阻尼（加速/减速），手感比恒速直线移动好得多；
 * 3. 移动方向按「水平朝向」计算，抬头时不会往天上飞（这是 FPS 的常见差异点）；
 * 4. Shift 加速、空格/C 升降，符合主流 3D 软件的肌肉记忆。
 */
export interface FlyControlOptions {
  domElement: HTMLElement;
  camera: THREE.PerspectiveCamera;
  rig: CameraRig;
  /** 移动速度（米/秒） */
  speed?: number;
  /** 加速倍率（按住 Shift） */
  boost?: number;
  /** 活动范围限制，避免飞出场景 */
  bounds?: { min: THREE.Vector3; max: THREE.Vector3 };
}

export class FlyControl {
  enabled = false;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly rig: CameraRig;
  private readonly dom: HTMLElement;
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();

  private yaw = 0;
  private pitch = 0;
  private baseSpeed: number;
  private boost: number;
  private bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly sensitivity = 0.0026;

  constructor(opts: FlyControlOptions) {
    this.camera = opts.camera;
    this.rig = opts.rig;
    this.dom = opts.domElement;
    this.baseSpeed = opts.speed ?? 9;
    this.boost = opts.boost ?? 3.2;
    this.bounds = opts.bounds ?? null;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  setBounds(bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null): void {
    this.bounds = bounds;
  }

  setSpeed(speed: number): void {
    this.baseSpeed = speed;
  }

  /** 进入漫游：把当前相机朝向解析成 yaw/pitch，避免切换瞬间跳视角 */
  enter(): void {
    this.enabled = true;
    this.syncAnglesFromCamera();
    this.velocity.set(0, 0, 0);
    this.keys.clear();
    this.dom.style.cursor = 'crosshair';
  }

  exit(): void {
    this.enabled = false;
    this.velocity.set(0, 0, 0);
    this.keys.clear();
    this.dragging = false;
    this.dom.style.cursor = 'grab';
  }

  /**
   * 每帧更新。返回 true 表示本帧相机被飞行控制接管。
   * 相机过渡（flyTo）进行中时让位，避免两套逻辑打架。
   */
  update(delta: number): boolean {
    if (!this.enabled) return false;
    if (this.rig.transition.active) return false;

    // --- 方向向量
    const forward = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).normalize();

    // 水平前进方向：抬头俯冲时也能贴地移动，手感更稳
    const flatForward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), flatForward).normalize().negate();

    const wish = new THREE.Vector3();
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) wish.add(flatForward);
    if (k.has('s') || k.has('arrowdown')) wish.sub(flatForward);
    if (k.has('a') || k.has('arrowleft')) wish.sub(right);
    if (k.has('d') || k.has('arrowright')) wish.add(right);
    if (k.has(' ')) wish.y += 1;
    if (k.has('c') || k.has('control')) wish.y -= 1;

    const speed = this.baseSpeed * (k.has('shift') ? this.boost : 1);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);

    // --- 阻尼：0.12 的插值系数在 60fps 下手感接近「有惯性的行走」
    const accel = 1 - Math.exp(-9 * delta);
    this.velocity.lerp(wish, accel);

    this.camera.position.addScaledVector(this.velocity, delta);

    // --- 边界约束
    if (this.bounds) {
      this.camera.position.clamp(this.bounds.min, this.bounds.max);
    }

    // --- 朝向
    this.camera.lookAt(this.camera.position.clone().add(forward));
    // 同步 rig.target，让 Orbit 切回来时不会看向奇怪的方向
    this.rig.target.copy(this.camera.position).add(flatForward);

    return true;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.keys.clear();
  }

  // ---------------------------------------------------------------- 内部

  private syncAnglesFromCamera(): void {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.yaw = Math.atan2(dir.x, dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();
    this.keys.add(key);
    // 防止空格滚动页面 / Ctrl 触发浏览器快捷键
    if (key === ' ' || key === 'control') e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.button !== 0 && e.button !== 2) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    this.yaw -= dx * this.sensitivity;
    // 限制俯仰，避免翻过头顶
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.sensitivity, -1.45, 1.45);
  };

  private readonly onPointerUp = (): void => {
    this.dragging = false;
  };
}
