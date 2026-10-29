import * as THREE from 'three';
import {
  beltTexture,
  brushedMetalTexture,
  concreteTexture,
  epoxyFloorTexture,
  screenTexture,
} from '../assets/proceduralTextures';
import type { QualityProfile } from '../core/quality';

/**
 * 材质增强：在 glTF 材质基础上叠加程序化贴图。
 *
 * 为什么走这一步而不是在 Blender 里烘贴图：
 * 1. Blender 导出的贴图要经过 KTX2 转换、体积变大（这个场景原本 590KB，
 *    加 4 张 512 贴图会到 1.5MB+）；
 * 2. 程序化贴图可按画质档位重新生成不同分辨率，low 档直接跳过；
 * 3. 贴图与材质解耦，换配色只需改 color，不动贴图。
 *
 * 匹配策略：按材质名（Blender 侧 MAT_xxx 命名稳定）而不是按 mesh 名，
 * 这样静态合批后的 MERGED_env_xxx 也能正确吃到贴图。
 */
export interface MaterialEnhanceResult {
  applied: number;
  textures: THREE.Texture[];
  setQuality(profile: QualityProfile): void;
  dispose(): void;
}

interface Slot {
  mat: THREE.MeshStandardMaterial;
  /** 生成器（档位变化时重新生成不同分辨率） */
  make: () => THREE.Texture;
  /** 平铺重复次数 */
  repeat: [number, number];
  /** 是否作为颜色贴图（否则用于 roughnessMap 等） */
  asColor: boolean;
  colorHint?: number;
  roughness?: number;
  metalness?: number;
}

export function enhanceMaterials(root: THREE.Object3D, profile: QualityProfile): MaterialEnhanceResult {
  const textures: THREE.Texture[] = [];
  const slots: Slot[] = [];
  const visited = new Set<THREE.Material>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const mat = m as THREE.MeshStandardMaterial;
      if (!mat?.isMeshStandardMaterial || visited.has(mat)) continue;
      visited.add(mat);

      const slot = classify(mat);
      if (slot) slots.push(slot);
    }
  });

  let applied = 0;

  const apply = (targetProfile: QualityProfile): void => {
    applied = 0;
    const tier = targetProfile.tier;
    // low 档：只保留地面与皮带这两张「信息量最大」的贴图，其余用纯色
    for (const slot of slots) {
      const allowed =
        tier === 'high' ? true : tier === 'medium' ? slot.asColor : slot.asColor && slot.repeat[0] >= 8;
      if (!allowed) continue;

      const tex = slot.make();
      tex.repeat.set(slot.repeat[0], slot.repeat[1]);
      tex.anisotropy = targetProfile.maxAnisotropy;
      tex.needsUpdate = true;
      textures.push(tex);

      if (slot.asColor) {
        slot.mat.map = tex;
        if (slot.colorHint !== undefined) slot.mat.color.setHex(slot.colorHint);
      }
      if (slot.roughness !== undefined) slot.mat.roughness = slot.roughness;
      if (slot.metalness !== undefined) slot.mat.metalness = slot.metalness;
      slot.mat.needsUpdate = true;
      applied += 1;
    }
    console.info(`[MaterialEnhance] ${applied} 个材质应用程序化贴图（tier=${tier}）`);
  };

  apply(profile);

  return {
    get applied() {
      return applied;
    },
    textures,
    setQuality(next: QualityProfile) {
      // 清掉旧贴图再按新档位重建（避免显存累积）
      for (const tex of textures) tex.dispose();
      textures.length = 0;
      for (const slot of slots) {
        if (slot.mat.map) {
          slot.mat.map = null;
          slot.mat.needsUpdate = true;
        }
      }
      apply(next);
    },
    dispose() {
      for (const tex of textures) tex.dispose();
      textures.length = 0;
      for (const slot of slots) {
        slot.mat.map = null;
        slot.mat.needsUpdate = true;
      }
    },
  };
}

function classify(mat: THREE.MeshStandardMaterial): Slot | null {
  const name = mat.name;

  // 环氧地坪：主地面，给轻微粗糙度扰动 + 压暗，避免反光过强
  if (name.includes('FloorEpoxy')) {
    return {
      mat,
      make: epoxyFloorTexture,
      repeat: [9, 7],
      asColor: true,
      colorHint: 0xa8b0ba,
      roughness: 0.28,
      metalness: 0.06,
    };
  }

  // 混凝土场地
  if (name.includes('FloorConcrete')) {
    return {
      mat,
      make: concreteTexture,
      repeat: [16, 13],
      asColor: true,
      colorHint: 0x8d9299,
      roughness: 0.86,
      metalness: 0.0,
    };
  }

  // 皮带：唯一需要 UV 滚动的材质
  if (name.includes('_belt') || name.includes('MAT_Belt')) {
    return {
      mat,
      make: beltTexture,
      repeat: [1, 6],
      asColor: true,
      colorHint: 0xffffff,
      roughness: 0.82,
      metalness: 0.0,
    };
  }

  // 拉丝金属
  if (name.includes('MetalBrushed')) {
    return {
      mat,
      make: brushedMetalTexture,
      repeat: [3, 3],
      asColor: true,
      colorHint: 0xc8ccd2,
      roughness: 0.34,
      metalness: 0.92,
    };
  }

  // 中控台屏幕
  if (name.includes('ScreenGlass') || name.includes('EmitCyan')) {
    return {
      mat,
      make: screenTexture,
      repeat: [1, 1],
      asColor: true,
      colorHint: 0xffffff,
    };
  }

  return null;
}
