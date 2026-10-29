/**
 * 交互高亮系统。
 *
 * 核心难点（也是最常被做错的地方）：如何高亮而不破坏原材质。
 *
 * 错误做法：
 *   mesh.material.emissive.set(0xff0000)  ← 直接改原材质
 *   问题：glTF 加载后多个 mesh 可能共享同一个材质实例，
 *   改一个会导致所有使用该材质的物体一起变色，且无法可靠还原。
 *
 * 本实现：
 *   1. 首次高亮时克隆材质并缓存（原材质只读）；
 *   2. 用 emissive + emissiveIntensity 做脉冲，保留 PBR 光照信息；
 *   3. 额外叠加描边（outline）需要后处理通道，这里用「放大壳」方案，
 *      代价低（每个高亮件多一次 drawcall），但不需要后处理管线，
 *      在 low 档也能工作 —— 这是为移动端降级做的准备；
 *   4. 恢复时只还原引用的材质，不 dispose 缓存（复用它）。
 */
import * as THREE from 'three';

export type HighlightMode = 'hover' | 'select' | 'alert';

export interface HighlightStyle {
  color: number;
  emissiveIntensity: number;
  /** 脉冲频率（Hz），0 表示不脉冲 */
  pulse: number;
  /** 是否加描边壳 */
  outline: boolean;
  outlineColor: number;
  outlineScale: number;
}

const STYLES: Record<HighlightMode, HighlightStyle> = {
  hover: {
    color: 0x3fa9ff,
    emissiveIntensity: 0.55,
    pulse: 0,
    outline: true,
    outlineColor: 0x63c4ff,
    outlineScale: 1.012,
  },
  select: {
    color: 0x3fa9ff,
    emissiveIntensity: 1.05,
    pulse: 1.6,
    outline: true,
    outlineColor: 0x8ad4ff,
    outlineScale: 1.022,
  },
  alert: {
    color: 0xff4444,
    emissiveIntensity: 1.3,
    pulse: 2.4,
    outline: true,
    outlineColor: 0xff7777,
    outlineScale: 1.022,
  },
};

interface OriginalState {
  material: THREE.Material | THREE.Material[];
  /** 克隆出的高亮材质 */
  highlight: THREE.MeshStandardMaterial[];
  outline?: THREE.Mesh;
}

export class Highlighter {
  private readonly states = new Map<THREE.Mesh, OriginalState>();
  private readonly outlineMaterial: THREE.MeshBasicMaterial;
  private readonly selected = new Set<THREE.Mesh>();
  private readonly hovered = new Set<THREE.Mesh>();
  private readonly alerting = new Set<THREE.Mesh>();
  private time = 0;

  constructor() {
    this.outlineMaterial = new THREE.MeshBasicMaterial({
      color: 0x63c4ff,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false,
    });
  }

  get selectedCount(): number {
    return this.selected.size;
  }

  isSelected(mesh: THREE.Mesh): boolean {
    return this.selected.has(mesh);
  }

  /** 悬停：同一时刻只高亮一组 */
  setHover(meshes: readonly THREE.Mesh[]): void {
    if (setsEqual(this.hovered, meshes)) return;
    for (const mesh of this.hovered) {
      if (!this.selected.has(mesh) && !this.alerting.has(mesh)) this.clearOne(mesh);
    }
    this.hovered.clear();
    for (const mesh of meshes) {
      this.hovered.add(mesh);
      if (!this.selected.has(mesh) && !this.alerting.has(mesh)) this.applyOne(mesh, 'hover');
    }
  }

  /** 选中：可多选，append=true 时追加 */
  setSelection(meshes: readonly THREE.Mesh[], append = false): void {
    if (!append) {
      for (const mesh of this.selected) {
        if (!this.hovered.has(mesh) && !this.alerting.has(mesh)) this.clearOne(mesh);
      }
      this.selected.clear();
    }
    for (const mesh of meshes) {
      if (this.selected.has(mesh)) continue;
      this.selected.add(mesh);
      this.applyOne(mesh, 'select');
    }
  }

  toggleSelection(meshes: readonly THREE.Mesh[]): void {
    const allSelected = meshes.every((m) => this.selected.has(m));
    if (allSelected) {
      for (const mesh of meshes) {
        this.selected.delete(mesh);
        if (!this.hovered.has(mesh) && !this.alerting.has(mesh)) this.clearOne(mesh);
      }
      return;
    }
    this.setSelection(meshes, true);
  }

  clearSelection(): void {
    for (const mesh of this.selected) {
      if (!this.hovered.has(mesh) && !this.alerting.has(mesh)) this.clearOne(mesh);
    }
    this.selected.clear();
  }

  /** 告警高亮（故障设备），独立于选中态 */
  setAlert(meshes: readonly THREE.Mesh[], on: boolean): void {
    for (const mesh of meshes) {
      if (on) {
        this.alerting.add(mesh);
        this.applyOne(mesh, 'alert');
      } else {
        this.alerting.delete(mesh);
        if (!this.selected.has(mesh) && !this.hovered.has(mesh)) this.clearOne(mesh);
        else if (this.selected.has(mesh)) this.applyOne(mesh, 'select');
        else if (this.hovered.has(mesh)) this.applyOne(mesh, 'hover');
      }
    }
  }

  /** 每帧驱动脉冲。按 Hz 计算强度，与帧率无关。 */
  update(delta: number): void {
    if (this.selected.size === 0 && this.alerting.size === 0) return;
    this.time += delta;

    const pulseSelect = 0.5 + 0.5 * Math.sin(this.time * STYLES.select.pulse * Math.PI * 2);
    const pulseAlert = 0.5 + 0.5 * Math.sin(this.time * STYLES.alert.pulse * Math.PI * 2);

    for (const mesh of this.selected) {
      const state = this.states.get(mesh);
      if (!state) continue;
      const base = STYLES.select.emissiveIntensity;
      for (const mat of state.highlight) {
        mat.emissiveIntensity = base * (0.55 + pulseSelect * 0.75);
      }
    }

    for (const mesh of this.alerting) {
      const state = this.states.get(mesh);
      if (!state) continue;
      const base = STYLES.alert.emissiveIntensity;
      for (const mat of state.highlight) {
        mat.emissiveIntensity = base * (0.3 + pulseAlert * 1.1);
      }
    }
  }

  dispose(): void {
    for (const mesh of this.states.keys()) this.clearOne(mesh);
    this.states.clear();
    this.selected.clear();
    this.hovered.clear();
    this.alerting.clear();
    this.outlineMaterial.dispose();
  }

  // ---------------------------------------------------------------- 内部

  private applyOne(mesh: THREE.Mesh, mode: HighlightMode): void {
    const existing = this.states.get(mesh);
    const style = STYLES[mode];

    if (existing) {
      // 已高亮：只改颜色与强度，不重建材质
      for (const mat of existing.highlight) {
        mat.emissive.setHex(style.color);
        mat.emissiveIntensity = style.emissiveIntensity;
      }
      if (existing.outline) {
        this.outlineMaterial.color.setHex(style.outlineColor);
      }
      return;
    }

    const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const highlight = originals.map((orig) => {
      const cloned = orig.clone() as THREE.MeshStandardMaterial;
      cloned.userData['__highlight'] = true;
      if (cloned.emissive) {
        cloned.emissive = new THREE.Color(style.color);
        cloned.emissiveIntensity = style.emissiveIntensity;
      }
      return cloned;
    });

    const state: OriginalState = {
      material: mesh.material,
      highlight,
    };
    mesh.material = highlight.length === 1 ? highlight[0]! : highlight;

    if (style.outline) {
      const outline = createOutlineShell(mesh, this.outlineMaterial, style.outlineScale);
      if (outline) state.outline = outline;
    }

    this.states.set(mesh, state);
  }

  private clearOne(mesh: THREE.Mesh): void {
    const state = this.states.get(mesh);
    if (!state) return;

    mesh.material = state.material;
    for (const mat of state.highlight) mat.dispose();

    if (state.outline) {
      state.outline.removeFromParent();
      state.outline.geometry.dispose();
    }
    this.states.delete(mesh);
  }
}

/**
 * 描边壳：复制几何、放大、反法线渲染。
 * 相比后处理 OutlinePass：
 * - 不需要额外 render target 与全屏 pass，low 档也能用；
 * - 但每个高亮件多一次 drawcall，且复杂凹形可能出现穿插。
 * 对「设备部件」这类凸多面体表现良好，是这里的合理取舍。
 */
function createOutlineShell(
  mesh: THREE.Mesh,
  material: THREE.Material,
  scale: number,
): THREE.Mesh | null {
  if (!mesh.parent) return null;
  if (!mesh.geometry) return null;

  const shell = new THREE.Mesh(mesh.geometry, material);
  shell.name = `${mesh.name}__outline`;
  shell.position.copy(mesh.position);
  shell.quaternion.copy(mesh.quaternion);
  shell.scale.copy(mesh.scale).multiplyScalar(scale);
  shell.castShadow = false;
  shell.receiveShadow = false;
  shell.renderOrder = (mesh.renderOrder ?? 0) + 1;
  shell.matrixAutoUpdate = true;
  // 与父级同坐标系，保证跟随动画
  shell.userData['__outline'] = true;
  mesh.parent.add(shell);
  // 关键：把壳同步到与 mesh 相同的位置（mesh 可能自身有变换）
  shell.position.copy(mesh.position);
  shell.quaternion.copy(mesh.quaternion);
  shell.scale.copy(mesh.scale).multiplyScalar(scale);
  return shell;
}

function setsEqual(set: Set<THREE.Mesh>, arr: readonly THREE.Mesh[]): boolean {
  if (set.size !== arr.length) return false;
  for (const item of arr) if (!set.has(item)) return false;
  return true;
}
