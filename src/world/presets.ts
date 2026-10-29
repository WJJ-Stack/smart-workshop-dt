import * as THREE from 'three';
import type { AssetManifest } from '../assets/manifest';
import type { CameraPose } from '../core/CameraRig';

/**
 * 机位预设：所有「讲故事」的镜头都在这里集中定义。
 *
 * 说明：厂房是 40×28×7.6 米的封闭空间，所以除「厂房外观」外，
 * 所有机位都必须落在墙体内部，否则会被墙挡住或直接看到外表面。
 * 这里用 manifest.hall 的真实尺寸做约束，改房子尺寸时机位自动适配。
 */
export interface ViewPreset {
  id: string;
  label: string;
  hotkey?: string;
  pose: CameraPose;
  description: string;
}

export function buildPresets(manifest: AssetManifest): ViewPreset[] {
  const { length: L, width: W, height: H } = manifest.hall;
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  // 安全内边界（保证相机不贴墙、不进屋面）
  const inX = L * 0.44;
  const inZ = W * 0.42;
  const maxY = H - 1.2;

  return [
    {
      id: 'overview',
      label: '车间总览',
      hotkey: '1',
      description: '西北角高位俯瞰整条产线',
      pose: {
        position: V(-inX, Math.min(6.6, maxY), inZ),
        target: V(-1, 1.3, 0),
        fov: 48,
        duration: 1.6,
      },
    },
    {
      id: 'line-follow',
      label: '产线视角',
      hotkey: '2',
      description: '沿产线方向平视，展示工序顺序',
      pose: {
        position: V(-L * 0.46, 2.9, 7.2),
        target: V(6, 1.4, 0),
        fov: 52,
        duration: 1.5,
      },
    },
    {
      id: 'robot-closeup',
      label: '机械臂特写',
      hotkey: '3',
      description: '对准装配工位，看关节动作与部件高亮',
      pose: {
        position: V(-11.4, 2.6, 4.6),
        target: V(-8.6, 1.4, 0),
        fov: 42,
        duration: 1.4,
      },
    },
    {
      id: 'inspection',
      label: '检测工位',
      hotkey: '4',
      description: '视觉检测龙门与扫描光幕',
      pose: {
        position: V(-2.4, 2.3, 4.4),
        target: V(0.6, 1.4, 0),
        fov: 44,
        duration: 1.4,
      },
    },
    {
      id: 'agv-lane',
      label: 'AGV 通道',
      hotkey: '5',
      description: '贴近地面看 AGV 行驶带与路径流光',
      pose: {
        position: V(-9, 1.9, -9.5),
        target: V(1, 0.7, -3.0),
        fov: 56,
        duration: 1.5,
      },
    },
    {
      id: 'roof',
      label: '俯视布局',
      hotkey: '6',
      description: '近俯视，看产线与 AGV 路网关系',
      pose: {
        position: V(0, maxY, inZ * 0.55),
        target: V(-2, 0, 0),
        fov: 44,
        duration: 1.7,
      },
    },
    {
      id: 'exterior',
      label: '厂房外观',
      hotkey: '7',
      description: '退到厂区，看建筑体量与外部环境',
      pose: {
        position: V(-L * 0.82, 15, -W * 0.92),
        target: V(0, 3.4, 0),
        fov: 40,
        duration: 1.8,
      },
    },
  ];
}
