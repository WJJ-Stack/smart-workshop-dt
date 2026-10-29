import type { Entity, PartInfo } from '../entities/EntityRegistry';
import type { EquipmentKind } from '../assets/manifest';

/**
 * 设备信息卡。
 *
 * 交互设计要点：
 * - 跟随选中实体，但用固定位置（右侧）而不是跟随鼠标：
 *   大屏场景里跟随鼠标的浮窗会遮挡画面且难以阅读；
 * - 部件列表可点击 → 单独聚焦该部件，这是「部件级拾取」最直观的展示；
 * - 状态、节拍、良率等数值由孪生数据源驱动（M5），这里只负责渲染。
 */
export interface InfoCardData {
  entityId: string;
  title: string;
  kind: EquipmentKind;
  station: number;
  status: 'running' | 'idle' | 'fault' | 'maintenance';
  parts: Array<{ partId: string; label: string; role?: string }>;
  metrics: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }>;
}

const KIND_LABEL: Record<EquipmentKind, string> = {
  feeder: '上料',
  conveyor: '输送',
  robot: '装配',
  inspection: '检测',
  packer: '包装',
  agv: '物流',
  cabinet: '电控',
  console: '中控',
};

const STATUS_LABEL: Record<InfoCardData['status'], string> = {
  running: '运行中',
  idle: '待机',
  fault: '故障',
  maintenance: '维护',
};

export class InfoCard {
  readonly el: HTMLDivElement;
  private visible = false;
  private onPartClick: ((entityId: string, partId: string) => void) | undefined;
  private onClose: (() => void) | undefined;
  private current: InfoCardData | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'info-card';
    parent.appendChild(this.el);
  }

  setHandlers(handlers: {
    onPartClick?: (entityId: string, partId: string) => void;
    onClose?: () => void;
  }): void {
    this.onPartClick = handlers.onPartClick;
    this.onClose = handlers.onClose;
  }

  show(data: InfoCardData): void {
    this.current = data;
    this.render();
    if (!this.visible) {
      this.visible = true;
      this.el.classList.add('is-visible');
    }
  }

  hide(): void {
    this.visible = false;
    this.current = null;
    this.el.classList.remove('is-visible');
  }

  updateMetrics(metrics: InfoCardData['metrics']): void {
    if (!this.current) return;
    this.current.metrics = metrics;
    this.renderMetrics();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  private render(): void {
    const d = this.current;
    if (!d) return;

    this.el.innerHTML = `
      <div class="info-card__head">
        <div class="info-card__tag">${KIND_LABEL[d.kind]}</div>
        <div class="info-card__title"></div>
        <button class="info-card__close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="info-card__meta">
        <span class="info-card__station">工位 ${String(d.station).padStart(2, '0')}</span>
        <span class="status-chip" data-status="${d.status}">${STATUS_LABEL[d.status]}</span>
      </div>
      <div class="info-card__metrics"></div>
      <div class="info-card__section-title">部件 <span class="info-card__count"></span></div>
      <div class="info-card__parts"></div>
    `;

    (this.el.querySelector('.info-card__title') as HTMLElement).textContent = d.title;
    (this.el.querySelector('.info-card__count') as HTMLElement).textContent = `${d.parts.length}`;

    const closeBtn = this.el.querySelector('.info-card__close') as HTMLButtonElement;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClose?.();
    });

    const partsEl = this.el.querySelector('.info-card__parts') as HTMLElement;
    for (const part of d.parts) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'part-row';
      row.innerHTML = `
        <span class="part-row__dot"></span>
        <span class="part-row__id"></span>
        <span class="part-row__role"></span>
      `;
      (row.querySelector('.part-row__id') as HTMLElement).textContent = part.partId;
      const roleEl = row.querySelector('.part-row__role') as HTMLElement;
      if (part.role) roleEl.textContent = part.role;
      else roleEl.remove();
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onPartClick?.(d.entityId, part.partId);
      });
      partsEl.appendChild(row);
    }

    this.renderMetrics();
  }

  private renderMetrics(): void {
    const d = this.current;
    if (!d) return;
    const el = this.el.querySelector('.info-card__metrics') as HTMLElement | null;
    if (!el) return;
    el.innerHTML = '';
    for (const m of d.metrics) {
      const box = document.createElement('div');
      box.className = 'metric';
      box.innerHTML = `
        <span class="metric__label"></span>
        <span class="metric__value" data-tone="${m.tone ?? ''}"></span>
      `;
      (box.querySelector('.metric__label') as HTMLElement).textContent = m.label;
      (box.querySelector('.metric__value') as HTMLElement).textContent = m.value;
      el.appendChild(box);
    }
  }

  static fromEntity(entity: Entity, status: InfoCardData['status']): InfoCardData {
    return {
      entityId: entity.id,
      title: entity.title,
      kind: entity.kind,
      station: entity.station,
      status,
      parts: entity.parts
        .map((p: PartInfo) => ({ partId: p.partId, label: p.partId, role: p.role }))
        .filter((p, i, arr) => arr.findIndex((x) => x.partId === p.partId) === i),
      metrics: [],
    };
  }

  dispose(): void {
    this.el.remove();
  }
}
