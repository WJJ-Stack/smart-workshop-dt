/**
 * 告警面板 + 全局指标条（OEE / 产量 / 良率 / 在线率）。
 *
 * 这类「大屏指标」在生产环境里通常由时序数据库聚合，
 * 这里用前端滑动窗口聚合，逻辑一致但不需要后端。
 */
export interface Kpi {
  key: string;
  label: string;
  value: string;
  unit?: string;
  tone?: 'ok' | 'warn' | 'bad';
  /** 迷你趋势（最近 24 个点，0..1 归一化） */
  trend?: number[];
}

export interface AlertItem {
  id: string;
  time: string;
  entityId: string;
  title: string;
  level: 'warn' | 'bad' | 'info';
  message: string;
}

export class KpiBar {
  readonly el: HTMLDivElement;
  private readonly kpis = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'kpi-bar';
    parent.appendChild(this.el);
  }

  set(kpis: Kpi[]): void {
    // 结构变化才重建，数值变化只改 textContent（避免每帧重建 DOM）
    if (this.kpis.size !== kpis.length || kpis.some((k) => !this.kpis.has(k.key))) {
      this.el.innerHTML = '';
      this.kpis.clear();
      for (const k of kpis) {
        const box = document.createElement('div');
        box.className = 'kpi';
        box.innerHTML = `
          <span class="kpi__label"></span>
          <span class="kpi__row">
            <span class="kpi__value" data-tone="${k.tone ?? ''}"></span>
            <span class="kpi__unit"></span>
          </span>
          <svg class="kpi__spark" viewBox="0 0 48 12" preserveAspectRatio="none">
            <polyline points="" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
        `;
        (box.querySelector('.kpi__label') as HTMLElement).textContent = k.label;
        this.el.appendChild(box);
        this.kpis.set(k.key, box);
      }
    }

    for (const k of kpis) {
      const box = this.kpis.get(k.key);
      if (!box) continue;
      const valEl = box.querySelector('.kpi__value') as HTMLElement;
      valEl.textContent = k.value;
      valEl.dataset['tone'] = k.tone ?? '';
      const unitEl = box.querySelector('.kpi__unit') as HTMLElement;
      unitEl.textContent = k.unit ?? '';
      const spark = box.querySelector('polyline') as SVGPolylineElement | null;
      if (spark && k.trend && k.trend.length > 1) {
        spark.setAttribute('points', toPolyline(k.trend, 48, 12));
        spark.parentElement?.classList.toggle('is-up', k.trend[k.trend.length - 1]! >= k.trend[0]!);
      }
    }
  }

  dispose(): void {
    this.el.remove();
    this.kpis.clear();
  }
}

function toPolyline(values: number[], w: number, h: number): string {
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = (i / (n - 1)) * w;
      const y = h - ((v - min) / span) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export class AlertFeed {
  readonly el: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly items: AlertItem[] = [];
  private readonly max = 6;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'alert-feed';
    this.el.innerHTML = `
      <div class="panel-title">实时告警 <span class="panel-title__hint">最近 ${6} 条</span></div>
      <div class="alert-feed__list"></div>
    `;
    parent.appendChild(this.el);
    this.listEl = this.el.querySelector('.alert-feed__list') as HTMLDivElement;
  }

  push(item: AlertItem): void {
    this.items.unshift(item);
    if (this.items.length > this.max) this.items.pop();
    this.render();
  }

  /** 某设备恢复后，把它的告警条目标记为已恢复而不是直接删掉 */
  resolve(entityId: string): void {
    let changed = false;
    for (const item of this.items) {
      if (item.entityId === entityId && item.level !== 'info') {
        item.level = 'info';
        item.message = '已恢复';
        changed = true;
      }
    }
    if (changed) this.render();
  }

  private render(): void {
    this.listEl.innerHTML = '';
    if (this.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'alert-empty';
      empty.textContent = '无告警';
      this.listEl.appendChild(empty);
      return;
    }
    for (const item of this.items) {
      const row = document.createElement('div');
      row.className = 'alert-row';
      row.dataset['level'] = item.level;
      row.innerHTML = `
        <span class="alert-row__time"></span>
        <span class="alert-row__body">
          <span class="alert-row__title"></span>
          <span class="alert-row__msg"></span>
        </span>
      `;
      (row.querySelector('.alert-row__time') as HTMLElement).textContent = item.time;
      (row.querySelector('.alert-row__title') as HTMLElement).textContent = item.title;
      (row.querySelector('.alert-row__msg') as HTMLElement).textContent = item.message;
      this.listEl.appendChild(row);
    }
  }

  dispose(): void {
    this.el.remove();
    this.items.length = 0;
  }
}
