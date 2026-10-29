import type { TilesViewerHandles, TilesStats } from './tiles';
import type { PointCloudHandles } from './pointcloud';
import type { SplatViewerHandles, SplatStats } from './splat';

/**
 * 资产展示页入口：统一管理 3D Tiles / 点云 / 3DGS 三种模式。
 *
 * 关键设计：
 * - **按需加载**：切换模式时才动态 import 对应模块，
 *   首屏只下载当前用到的渲染代码（三个模块互不依赖，各 10~30KB）；
 * - **彻底销毁**：切走时调用 dispose()，释放 GL 资源与 rAF，
 *   否则切几次显存就爆（每个模块各自持有自己的 WebGLRenderer）；
 * - **URL 同步**：`?mode=splat` 可直接分享某个模式，便于面试时给链接。
 */
type Mode = 'tiles' | 'points' | 'splat';

interface ModeModule {
  dispose: () => void;
}

const BASE = 'assets/';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 #${id}`);
  return node as T;
}

const canvas = el<HTMLCanvasElement>('canvas');
const statsBox = el<HTMLDivElement>('stats');
const ctrlBox = el<HTMLDivElement>('ctrl');
const noteBox = el<HTMLDivElement>('note');
const boot = el<HTMLDivElement>('boot');
const bootBar = el<HTMLElement>('bootBar');
const bootMsg = el<HTMLDivElement>('bootMsg');
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab[data-mode]')];

let current: ModeModule | null = null;
let currentMode: Mode | null = null;
let loadToken = 0;

function setBoot(ratio: number, message: string): void {
  bootBar.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  bootMsg.textContent = message;
  bootMsg.classList.remove('err');
}

function failBoot(message: string): void {
  boot.classList.remove('off');
  bootMsg.textContent = message;
  bootMsg.classList.add('err');
  bootBar.style.background = 'var(--bad)';
}

function finishBoot(): void {
  boot.classList.add('off');
}

function stats(rows: Array<[string, string]>): void {
  statsBox.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="row"><span>${k}</span><span>${v}</span></div>`,
    )
    .join('');
}

function setNote(html: string): void {
  noteBox.innerHTML = html;
}

function clearControls(): void {
  ctrlBox.innerHTML = '';
}

function addSlider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
): void {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => onInput(Number(input.value)));
  wrap.appendChild(input);
  ctrlBox.appendChild(wrap);
}

function addButton(label: string, onClick: () => void): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  ctrlBox.appendChild(btn);
}

// ---------------------------------------------------------------- 三个模式

async function mountTiles(): Promise<ModeModule> {
  setNote(
    '<b>3D Tiles</b>：由 <code>tools/blender/build_tiles.py</code> 把车间切成 8 个空间单元 × 2 级 LOD = 16 个瓦片。' +
      '移动相机时可在 Network 面板看到按需请求。',
  );
  setBoot(0.2, '加载 3D Tiles…');

  const { createTilesViewer } = await import('./tiles');
  const viewer: TilesViewerHandles = await createTilesViewer(canvas, BASE, (s: TilesStats) => {
    stats([
      ['可见瓦片', `<b>${s.visible}</b>`],
      ['激活瓦片', String(s.active)],
      ['已加载内容', String(s.requests)],
      ['下载中', String(s.downloading)],
      ['已下载', `${(s.bytes / 1048576).toFixed(2)} MB`],
    ]);
  });

  clearControls();
  addButton('重置视角', () => viewer.reset());
  addSlider('屏幕误差阈值', 2, 80, 1, 40, (v) => viewer.setGeometricError(v));
  finishBoot();

  return {
    dispose: () => viewer.dispose(),
  };
}

async function mountPoints(): Promise<ModeModule> {
  setNote(
    '<b>点云</b>：40 万点真实场景点云，由 <code>export_pointcloud.py</code> 按三角面面积加权采样导出为 PLY。' +
      '拖动滑块可减少绘制点数（用 <code>setDrawRange</code>，不是重构几何）。',
  );
  setBoot(0.05, '加载点云…');

  const { createPointCloudViewer } = await import('./pointcloud');
  const viewer: PointCloudHandles = await createPointCloudViewer(
    canvas,
    `${BASE}splat/workshop.ply`,
    (r, m) => setBoot(0.05 + r * 0.9, m),
  );

  const renderStats = (): void => {
    const s = viewer.stats();
    stats([
      ['总点数', s.points.toLocaleString()],
      ['绘制点数', `<b>${s.rendered.toLocaleString()}</b>`],
      ['点大小', s.size.toFixed(3)],
    ]);
  };
  renderStats();

  clearControls();
  addSlider('点大小', 0.004, 0.08, 0.002, 0.022, (v) => {
    viewer.setPointSize(v);
    renderStats();
  });
  addSlider('绘制比例', 0.05, 1, 0.05, 1, (v) => {
    viewer.setDrawRatio(v);
    renderStats();
  });
  addButton('切换着色', () => {
    const mode = viewer.toggleColorMode();
    addButton; // no-op
    noteBox.dataset['colormode'] = mode;
  });
  addButton('重置视角', () => viewer.resetCamera());
  finishBoot();

  return {
    dispose: () => viewer.dispose(),
  };
}

async function mountSplat(): Promise<ModeModule> {
  setNote(
    '<b>3DGS</b>：15 万个各向异性高斯，自定义 WebGL2 实例化渲染器' +
      '（3D 协方差 → 2D 屏幕空间投影 + 每帧深度排序 + 预乘 alpha）。' +
      '<span class="tag">几何采样生成</span>',
  );
  setBoot(0.05, '加载 .splat…');

  const { createSplatViewer } = await import('./splat');
  const viewer: SplatViewerHandles = await createSplatViewer(
    canvas,
    `${BASE}splat/workshop.splat`,
    (r, m) => setBoot(0.05 + r * 0.9, m),
  );

  const renderStats = (): void => {
    const s: SplatStats = viewer.stats();
    stats([
      ['高斯数量', `<b>${s.gaussians.toLocaleString()}</b>`],
      ['数据量', `${(s.bytes / 1048576).toFixed(2)} MB`],
      ['排序耗时', `${s.sortMs.toFixed(1)} ms`],
      ['每高斯', '32 B'],
    ]);
  };
  renderStats();

  let sorting = true;
  clearControls();
  addButton('深度排序：开', () => {
    sorting = !sorting;
    viewer.setSorting(sorting);
    const btn = ctrlBox.querySelector('button');
    if (btn) btn.textContent = `深度排序：${sorting ? '开' : '关'}`;
  });
  addButton('重置视角', () => viewer.resetCamera());
  finishBoot();

  const timer = window.setInterval(renderStats, 500);

  return {
    dispose: () => {
      window.clearInterval(timer);
      viewer.dispose();
    },
  };
}

// ---------------------------------------------------------------- 路由

async function switchMode(mode: Mode): Promise<void> {
  if (mode === currentMode && current) return;

  const token = ++loadToken;
  currentMode = mode;
  for (const t of tabs) t.classList.toggle('on', t.dataset['mode'] === mode);

  // 先彻底销毁旧模式，避免两个 WebGL 上下文并存吃显存
  current?.dispose();
  current = null;
  clearControls();
  statsBox.innerHTML = '';
  bootBar.style.background = '';
  boot.classList.remove('off');
  setBoot(0.05, '准备中…');

  try {
    let mod: ModeModule;
    if (mode === 'tiles') mod = await mountTiles();
    else if (mode === 'points') mod = await mountPoints();
    else mod = await mountSplat();

    // 加载期间用户又切走了 → 立刻销毁这次的结果
    if (token !== loadToken) {
      mod.dispose();
      return;
    }
    current = mod;

    const url = new URL(location.href);
    url.searchParams.set('mode', mode);
    history.replaceState(null, '', url.toString());
  } catch (err) {
    console.error(`[asset-viewer] ${mode} 加载失败`, err);
    if (token === loadToken) {
      failBoot(`加载失败：${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------- 启动

for (const t of tabs) {
  t.addEventListener('click', () => {
    const mode = t.dataset['mode'] as Mode | undefined;
    if (mode) void switchMode(mode);
  });
}

el<HTMLButtonElement>('back').addEventListener('click', () => {
  location.href = './';
});

const initial = (new URLSearchParams(location.search).get('mode') as Mode | null) ?? 'tiles';
void switchMode(initial);

window.addEventListener('beforeunload', () => {
  current?.dispose();
  current = null;
});

// 调试用：暴露给 console
Object.assign(window, {
  __assetMode: () => currentMode,
  __switchMode: switchMode,
});
