import type * as THREE from 'three';
import type { CameraPose } from '../core/CameraRig';
import type { QualityProfile } from '../core/quality';
import type { PartInfo } from '../entities/EntityRegistry';

/**
 * 全局事件契约。
 *
 * 集中定义而不是分散在各模块里，是为了让 `EventBus<AppEvents>` 对所有
 * 生产者和消费者都保持同一份类型约束。新增事件只改这里一处。
 */
export interface AppEvents extends Record<string, unknown> {
  'quality:changed': { profile: QualityProfile };
  'camera:transition:start': { to: CameraPose };
  'camera:transition:end': Record<string, never>;
  resize: { width: number; height: number; pixelRatio: number };

  'pick:hover': { part: PartInfo | null; point: THREE.Vector3 | null };
  'pick:select': { parts: PartInfo[]; entityIds: string[] };
  'pick:clear': Record<string, never>;

  'hotspot:click': { id: string; entityId: string };

  'twin:status': { entityId: string; status: TwinStatus; metrics: TwinMetric[] };
  'twin:alert': { entityId: string; level: 'warn' | 'bad'; message: string };

  'route:planned': { path: THREE.Vector3[]; distance: number; entityIds: string[] };
  'route:clear': Record<string, never>;

  'ui:ui-hidden': { hidden: boolean };
}

export type TwinStatus = 'running' | 'idle' | 'fault' | 'maintenance';

export interface TwinMetric {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
}
