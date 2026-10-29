import type { EquipmentKind } from '../assets/manifest';
import type { Entity } from '../entities/EntityRegistry';

/**
 * 顶部工具栏 + 左侧设备列表。
 *
 * 设计考虑：
 * - 大屏场景 UI 必须「可隐藏」：演示时按 H 隐藏所有 UI 得到纯净画面；
 * - 设备列表按工位排序，点一下飞过去，这是最常见的操作路径；
 * - 画质切换放在 UI 里而不是只靠快捷键，验收时对方能自己试。
 */
export interface ToolbarActions {
  onPreset: (id: string) => void;
  onQuality: (tier: 'high' | 'medium' | 'low') => void;
  onToggleHotspots: () => void;
  onToggleHud: () => void;
  onToggleFly: () => void;
  onReset: () => void;
}

export interface DeviceListActions {
  onSelect: (entityId: string) => void;
}

const KIND_ICON: Record<EquipmentKind, string> = {
  feeder: '▤',
  conveyor: '▬',
  robot: '◈',
  inspection: '◎',
  packer: '▣',
  agv: '⬢',
  cabinet: '▥',
  console: '▦',
};

export class TopBar {
  readonly el: HTMLDivElement;
  private readonly presetBtns = new Map<string, HTMLButtonElement>();
  private readonly qualityBtns = new Map<string, HTMLButtonElement>();
  private actions!: ToolbarActions;

  constructor(parent: HTMLElement, presets: Array<{ id: string; label: string; hotkey?: string }>) {
    this.el = document.createElement('div');
    this.el.className = 'topbar';
    this.el.innerHTML = `
      <div class="topbar__brand">
        <span class="topbar__logo"></span>
        <span class="topbar__name">智能装配车间 · 数字孪生</span>
      </div>
      <div class="topbar__group topbar__views"></div>
      <div class="topbar__spacer"></div>
      <div class="topbar__group topbar__quality"></div>
      <div class="topbar__group topbar__tools"></div>
    `;
    parent.appendChild(this.el);

    const viewsEl = this.el.querySelector('.topbar__views') as HTMLElement;
    for (const p of presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.dataset['preset'] = p.id;
      btn.innerHTML = `<span class="chip__text"></span>${p.hotkey ? `<span class="chip__key">${p.hotkey}</span>` : ''}`;
      (btn.querySelector('.chip__text') as HTMLElement).textContent = p.label;
      btn.addEventListener('click', () => this.actions?.onPreset(p.id));
      viewsEl.appendChild(btn);
      this.presetBtns.set(p.id, btn);
    }

    const qualityEl = this.el.querySelector('.topbar__quality') as HTMLElement;
    for (const [tier, label] of [
      ['high', '高'],
      ['medium', '中'],
      ['low', '低'],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip chip--sm';
      btn.dataset['tier'] = tier;
      btn.textContent = label;
      btn.title = `画质：${label}`;
      btn.addEventListener('click', () => this.actions?.onQuality(tier));
      qualityEl.appendChild(btn);
      this.qualityBtns.set(tier, btn);
    }

    const toolsEl = this.el.querySelector('.topbar__tools') as HTMLElement;
    const tools: Array<[string, string, keyof ToolbarActions]> = [
      ['hs', '热点', 'onToggleHotspots'],
      ['hud', '性能', 'onToggleHud'],
      ['fly', '漫游', 'onToggleFly'],
      ['reset', '复位', 'onReset'],
    ];
    for (const [key, label, action] of tools) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip chip--ghost';
      btn.dataset['tool'] = key;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        (this.actions[action] as () => void)();
      });
      toolsEl.appendChild(btn);
    }
  }

  bind(actions: ToolbarActions): void {
    this.actions = actions;
  }

  setActivePreset(id: string): void {
    for (const [key, btn] of this.presetBtns) {
      btn.classList.toggle('is-active', key === id);
    }
  }

  setActiveQuality(tier: string): void {
    for (const [key, btn] of this.qualityBtns) {
      btn.classList.toggle('is-active', key === tier);
    }
  }

  setToolState(tool: string, on: boolean): void {
    const btn = this.el.querySelector(`[data-tool="${tool}"]`) as HTMLButtonElement | null;
    btn?.classList.toggle('is-active', on);
  }
}

export class DeviceList {
  readonly el: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private actions: DeviceListActions | undefined;
  private current: string | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'device-list';
    this.el.innerHTML = `
      <div class="panel-title">产线设备 <span class="panel-title__hint">点击定位</span></div>
      <div class="device-list__rows"></div>
    `;
    parent.appendChild(this.el);
    this.listEl = this.el.querySelector('.device-list__rows') as HTMLDivElement;
  }

  bind(actions: DeviceListActions): void {
    this.actions = actions;
  }

  render(entities: Entity[]): void {
    this.listEl.innerHTML = '';
    const sorted = [...entities]
      .filter((e) => e.kind !== 'cabinet' && e.kind !== 'console')
      .sort((a, b) => a.station - b.station || a.id.localeCompare(b.id));

    for (const entity of sorted) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'device-row';
      row.dataset['id'] = entity.id;
      row.innerHTML = `
        <span class="device-row__icon"></span>
        <span class="device-row__main">
          <span class="device-row__title"></span>
          <span class="device-row__sub"></span>
        </span>
        <span class="device-row__status" data-status="idle"></span>
      `;
      (row.querySelector('.device-row__icon') as HTMLElement).textContent = KIND_ICON[entity.kind];
      (row.querySelector('.device-row__title') as HTMLElement).textContent = entity.title;
      (row.querySelector('.device-row__sub') as HTMLElement).textContent =
        entity.station > 0 ? `工位 ${String(entity.station).padStart(2, '0')}` : entity.id;
      row.addEventListener('click', () => {
        this.setActive(entity.id);
        this.actions?.onSelect(entity.id);
      });
      this.listEl.appendChild(row);
    }
  }

  setActive(id: string | null): void {
    this.current = id;
    for (const row of this.listEl.querySelectorAll('.device-row')) {
      row.classList.toggle('is-active', (row as HTMLElement).dataset['id'] === id);
    }
  }

  /** 更新某设备的状态点（M5 孪生数据驱动） */
  setStatus(entityId: string, status: 'running' | 'idle' | 'fault' | 'maintenance'): void {
    const row = this.listEl.querySelector(`[data-id="${entityId}"] .device-row__status`);
    if (row instanceof HTMLElement) {
      row.dataset['status'] = status;
      row.textContent =
        status === 'running' ? 'RUN' : status === 'fault' ? 'ERR' : status === 'maintenance' ? 'MNT' : 'IDLE';
    }
  }

  get activeId(): string | null {
    return this.current;
  }

  dispose(): void {
    this.el.remove();
  }
}
