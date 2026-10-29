import type { RoadNetwork } from '../systems/RoadNetwork';

/**
 * 路径规划面板：选目的地 → 规划 → 高亮结果。
 *
 * UI 取舍：不做「在地面上点一下当作目的地」，
 * 因为那会和 3D 拾取冲突（用户想选设备时可能点到地面）。
 * 用命名站点（下拉/按钮）更符合工业场景语义 —— 现场调度就是选「站」。
 */
export interface RoutePanelActions {
  onPlan: (stationId: string) => void;
  onClear: () => void;
  onDispatchAgv: (stationId: string) => void;
  onFollowAgv: () => void;
  onStopFollow: () => void;
}

export class RoutePanel {
  readonly el: HTMLDivElement;
  private readonly stationEl: HTMLDivElement;
  private readonly resultEl: HTMLDivElement;
  private actions: RoutePanelActions | undefined;
  private selected: string | null = null;

  constructor(parent: HTMLElement, network: RoadNetwork) {
    this.el = document.createElement('div');
    this.el.className = 'route-panel';
    this.el.innerHTML = `
      <div class="panel-title">AGV 调度 <span class="panel-title__hint">路网 ${network.graph.nodes.length} 节点</span></div>
      <div class="route-panel__stations"></div>
      <div class="route-panel__result"></div>
      <div class="route-panel__actions">
        <button type="button" class="chip chip--sm" data-act="dispatch">派车</button>
        <button type="button" class="chip chip--sm" data-act="follow">跟随</button>
        <button type="button" class="chip chip--sm chip--ghost" data-act="clear">清除</button>
      </div>
    `;
    parent.appendChild(this.el);

    this.stationEl = this.el.querySelector('.route-panel__stations') as HTMLDivElement;
    this.resultEl = this.el.querySelector('.route-panel__result') as HTMLDivElement;

    for (const st of network.stations) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'station-btn';
      btn.dataset['station'] = st.id;
      btn.textContent = st.name;
      btn.addEventListener('click', () => {
        this.setSelected(st.id);
        this.actions?.onPlan(st.id);
      });
      this.stationEl.appendChild(btn);
    }

    for (const btn of this.el.querySelectorAll('[data-act]')) {
      btn.addEventListener('click', () => {
        const act = (btn as HTMLElement).dataset['act'];
        if (act === 'dispatch' && this.selected) this.actions?.onDispatchAgv(this.selected);
        if (act === 'follow') this.actions?.onFollowAgv();
        if (act === 'clear') {
          this.setSelected(null);
          this.actions?.onClear();
        }
      });
    }
  }

  bind(actions: RoutePanelActions): void {
    this.actions = actions;
  }

  setSelected(stationId: string | null): void {
    this.selected = stationId;
    for (const btn of this.stationEl.querySelectorAll('.station-btn')) {
      btn.classList.toggle('is-active', (btn as HTMLElement).dataset['station'] === stationId);
    }
  }

  setResult(info: { distance: number; ms: number; expanded: number } | null): void {
    if (!info) {
      this.resultEl.innerHTML = '';
      return;
    }
    this.resultEl.innerHTML = `
      <span class="route-stat"><b>${info.distance.toFixed(1)}</b> m</span>
      <span class="route-stat"><b>${info.ms.toFixed(1)}</b> ms</span>
      <span class="route-stat"><b>${info.expanded}</b> 展开</span>
    `;
  }

  setError(message: string): void {
    this.resultEl.innerHTML = `<span class="route-err">${message}</span>`;
  }

  dispose(): void {
    this.el.remove();
  }
}
