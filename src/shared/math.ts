import * as THREE from 'three';

/** 世界坐标系约定：Y 轴向上，单位为米。 */
export const UP = new THREE.Vector3(0, 1, 0);

/** 数字格式化，用于 HUD 与面板 */
export function fmt(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 10000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return value.toFixed(digits);
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** 帧率档位到颜色，用于 HUD 着色 */
export function fpsColor(fps: number): string {
  if (fps >= 55) return 'ok';
  if (fps >= 40) return 'warn';
  return 'bad';
}

/** 线性插值 + 指数平滑（帧率无关） */
export function damp(current: number, target: number, lambda: number, delta: number): number {
  return THREE.MathUtils.damp(current, target, lambda, delta);
}

/** 把角度归一化到 [-PI, PI] */
export function wrapAngle(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

/** 判断是否触摸设备（用于输入层切换） */
export function isCoarsePointer(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

/**
 * 计算一组对象的世界包围盒（跳过不可见对象）。
 * 用于「点击实体 → 相机飞向该实体」这类功能。
 */
export function computeWorldBounds(objects: readonly THREE.Object3D[]): THREE.Box3 {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const obj of objects) {
    if (!obj.visible) continue;
    tmp.setFromObject(obj);
    if (tmp.isEmpty()) continue;
    box.union(tmp);
  }
  return box;
}

/**
 * 由包围盒推导观察该物体的相机位姿。
 * 保持固定俯角，避免每次飞过去都是奇奇怪怪的角度。
 */
export function poseToFrameBox(
  box: THREE.Box3,
  opts: { pitchDeg?: number; yawDeg?: number; padding?: number; minDistance?: number } = {},
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const { pitchDeg = 32, yawDeg = -38, padding = 1.5, minDistance = 4 } = opts;
  const target = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.001);
  const fovRad = THREE.MathUtils.degToRad(45);
  const distance = Math.max(minDistance, (radius * padding) / Math.sin(fovRad * 0.5));

  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const dir = new THREE.Vector3(
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ).multiplyScalar(distance);

  return { position: target.clone().add(dir), target };
}
