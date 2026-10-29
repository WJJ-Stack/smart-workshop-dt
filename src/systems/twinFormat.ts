import type { TwinMetric, TwinStatus } from '../shared/events';
import type { TwinSnapshot } from './TwinSource';

const STATUS_LABEL: Record<TwinStatus, string> = {
  running: '运行中',
  idle: '待机',
  fault: '故障',
  maintenance: '维护',
};

export function statusLabel(status: TwinStatus): string {
  return STATUS_LABEL[status];
}

export function metricsFor(snap: TwinSnapshot | undefined, kind: string): TwinMetric[] {
  if (!snap) {
    // 数据源还没吐出第一个快照时的兜底，避免面板空白
    return [
      { label: '状态', value: '初始化' },
      { label: '类型', value: kind },
    ];
  }
  return snap.metrics;
}

export function clockTime(date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
