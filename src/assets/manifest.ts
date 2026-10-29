/**
 * 资产清单的类型定义。
 * 与 tools/blender/build_workshop.py 的 write_manifest() 输出严格对应。
 * 修改一端必须同步另一端 —— 这是前后端的契约。
 */

export interface ModelExport {
  file: string;
  lod?: string;
  tris?: number;
  verts?: number;
  bytes?: number;
  exportSec?: number;
}

export interface LodEntry {
  level: number;
  file: string;
  maxDistance: number;
}

export interface HallDims {
  length: number;
  width: number;
  height: number;
}

export interface EquipmentMeta {
  kind: EquipmentKind;
  title: string;
  station: number;
}

export type EquipmentKind =
  | 'feeder'
  | 'conveyor'
  | 'robot'
  | 'inspection'
  | 'packer'
  | 'agv'
  | 'cabinet'
  | 'console';

export interface AssetManifest {
  version: number;
  generatedBy: string;
  units: string;
  upAxis: string;
  hall: HallDims;
  models: ModelExport[];
  lods: LodEntry[];
  layout: Record<string, { x: number; y: number; z: number }>;
  animations: Record<string, string>;
  equipment: Record<string, EquipmentMeta>;
}

/** glTF 节点 extras.dt 的结构（Blender 侧写入的字符串 JSON） */
export interface DtMeta {
  kind?: string;
  title?: string;
  group?: string;
  station?: number;
  role?: string;
  joint?: string;
  length?: number;
  uv_scroll?: boolean;
  material?: string;
  [key: string]: unknown;
}

/** 从 Object3D.userData.dt 安全解析元数据 */
export function readDt(userData: Record<string, unknown> | undefined): DtMeta | null {
  if (!userData) return null;
  const raw = userData['dt'];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as DtMeta;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as DtMeta;
  return null;
}

/** 从节点名解析实体/部件：EQ_robot_01 / P_EQ_robot_01__upper_arm */
export interface ParsedName {
  prefix: 'EQ' | 'P' | 'ENV' | 'MERGED' | 'other';
  entity: string;
  part: string | null;
}

export function parseName(name: string): ParsedName {
  if (name.startsWith('P_')) {
    const rest = name.slice(2);
    const sep = rest.indexOf('__');
    if (sep === -1) return { prefix: 'P', entity: rest, part: null };
    return { prefix: 'P', entity: rest.slice(0, sep), part: rest.slice(sep + 2) };
  }
  if (name.startsWith('EQ_')) return { prefix: 'EQ', entity: name, part: null };
  if (name.startsWith('ENV_')) return { prefix: 'ENV', entity: name, part: null };
  if (name.startsWith('MERGED_')) return { prefix: 'MERGED', entity: name, part: null };
  return { prefix: 'other', entity: name, part: null };
}
