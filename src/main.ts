import * as THREE from 'three';
import { App } from './App';
import { loadManifest } from './assets/loadManifest';
import { InteractionController } from './interaction/InteractionController';
import { BootScreen } from './ui/BootScreen';
import { InfoCard } from './ui/InfoCard';
import { PerfHud } from './ui/PerfHud';
import { DeviceList, TopBar } from './ui/Panels';
import { AlertFeed, KpiBar, type AlertItem, type Kpi } from './ui/Dashboard';
import { WorkshopWorld } from './world/WorkshopWorld';
import { buildPresets } from './world/presets';
import { HotspotBuilder } from './world/hotspots';
import { MockTwinSource } from './systems/TwinSource';
import { TwinBinding } from './systems/TwinBinding';
import { clockTime, metricsFor, statusLabel } from './systems/twinFormat';
import type { EquipmentKind } from './assets/manifest';
import type { TwinStatus } from './shared/events';
import './ui/styles.css';

const ASSET_BASE = 'assets/models/';

async function bootstrap(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#viewport');
  const overlay = document.querySelector<HTMLElement>('#overlay');
  if (!canvas || !overlay) throw new Error('缺少 #viewport / #overlay 容器');

  const boot = new BootScreen(overlay);
  boot.progress(4, '检测渲染能力…');

  let app: App;
  try {
    app = new App({ canvas, overlay });
  } catch (err) {
    console.error(err);
    boot.fail('WebGL 初始化失败，请确认浏览器已开启硬件加速');
    return;
  }

  boot.progress(14, `画质档位 ${app.quality.tier.toUpperCase()}`);

  let manifest;
  try {
    manifest = await loadManifest(ASSET_BASE);
  } catch (err) {
    console.error(err);
    boot.fail((err as Error).message);
    return;
  }

  boot.progress(20, '构建车间场景…');

  const world = new WorkshopWorld({
    manifest,
    baseUrl: ASSET_BASE,
    onProgress: (ratio, message) => boot.progress(20 + ratio * 62, message),
  });

  try {
    await app.mount(world);
  } catch (err) {
    console.error(err);
    boot.fail(`场景构建失败：${(err as Error).message}`);
    return;
  }

  boot.progress(84, '构建空间索引…');

  const interaction = new InteractionController({
    app,
    registry: world.registry,
    overlay,
    getOccluders: () => {
      const meshes: THREE.Object3D[] = [];
      world.sceneRoot.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && !obj.userData['__outline']) meshes.push(mesh);
      });
      return meshes;
    },
  });

  const bvh = interaction.prepare();
  boot.progress(90, `索引就绪（${bvh.meshes} 网格 / ${bvh.ms.toFixed(0)}ms）`);

  // ---------------- 孪生数据源
  const entities = world.registry.listEntities();
  const twin = new MockTwinSource(
    entities.map((e) => ({ id: e.id, kind: e.kind as string })),
  );

  // ---------------- UI
  const presets = buildPresets(manifest);
  const topbar = new TopBar(overlay, presets);
  const deviceList = new DeviceList(overlay);
  const infoCard = new InfoCard(overlay);
  const hud = new PerfHud(overlay);
  const kpiBar = new KpiBar(overlay);
  const alertFeed = new AlertFeed(overlay);

  deviceList.render(entities);

  // ---------------- 热点
  const hotspotBuilder = new HotspotBuilder(world.registry, manifest);
  const hotspotSpecs = hotspotBuilder.build((id) => {
    const entityId = hotspotBuilder.entityOf(id);
    if (entityId) interaction.focusEntity(entityId, { select: true });
  });
  interaction.setHotspots(hotspotSpecs);
  interaction.attachHotspots(world.sceneRoot);

  // ---------------- 孪生绑定（状态灯 + 标签 + UI）
  const alertCooldown = new Map<string, number>();
  const binding = new TwinBinding({
    registry: world.registry,
    source: twin,
    onSnapshot: (snaps) => {
      // 更新左侧列表状态与 KPI
      for (const snap of snaps) {
        deviceList.setStatus(snap.entityId, snap.status);
      }
      kpiBar.set(buildKpis(snaps, deviceList, world));
      if (interaction.currentSelection) {
        const sel = twin.get(interaction.currentSelection);
        if (sel) infoCard.updateMetrics(metricsFor(sel, ''));
      }
    },
    onStatusChange: (entityId, status, prev) => {
      const entity = world.registry.getEntity(entityId);
      const title = entity?.title ?? entityId;
      const meshes = world.registry.meshesOf(entityId);

      if (status === 'fault') {
        interaction.highlighter.setAlert(meshes, true);
        const now = performance.now();
        const last = alertCooldown.get(entityId) ?? 0;
        if (now - last > 3000) {
          alertCooldown.set(entityId, now);
          alertFeed.push(makeAlert(entityId, title, 'bad', '设备故障，已停机'));
        }
      } else if (status === 'maintenance') {
        interaction.highlighter.setAlert(meshes, false);
        alertFeed.push(makeAlert(entityId, title, 'warn', '进入维护流程'));
      } else {
        interaction.highlighter.setAlert(meshes, false);
        if (prev === 'fault' || prev === 'maintenance') {
          alertFeed.resolve(entityId);
        }
      }

      // 选中态同步刷新信息卡的状态
      if (interaction.currentSelection === entityId) {
        const snap = twin.get(entityId);
        if (snap && entity) {
          const data = InfoCard.fromEntity(entity, snap.status);
          data.metrics = metricsFor(snap, entity.kind);
          infoCard.show(data);
        }
      }
    },
  });

  // ---------------- 相机与预设
  app.flyTo(presets[0]!.pose, () => {
    topbar.setActivePreset('overview');
    interaction.hotspots.setEnabled(true);
  });

  const applyPreset = (id: string): void => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    topbar.setActivePreset(id);
    app.flyTo(preset.pose);
  };

  topbar.bind({
    onPreset: applyPreset,
    onQuality: (tier) => {
      app.setQuality(tier);
      topbar.setActiveQuality(tier);
    },
    onToggleHotspots: () => {
      const on = !interaction.hotspots.isEnabled;
      interaction.hotspots.setEnabled(on);
      topbar.setToolState('hs', on);
    },
    onToggleHud: () => {
      hud.toggle();
      topbar.setToolState('hud', hud.isVisible);
    },
    onToggleFly: () => {
      const next = !app.orbit.controls.autoRotate;
      app.orbit.setAutoRotate(next);
      topbar.setToolState('fly', next);
    },
    onReset: () => {
      applyPreset('overview');
      interaction.selectEntity(null);
    },
  });

  topbar.setActiveQuality(app.quality.tier);
  topbar.setToolState('hs', true);

  deviceList.bind({
    onSelect: (entityId) => interaction.focusEntity(entityId, { select: true }),
  });

  // ---------------- 选中 → 信息卡
  app.bus.on('pick:select', ({ entityIds }) => {
    const entityId = entityIds[0];
    if (!entityId) return;
    const entity = world.registry.getEntity(entityId);
    if (!entity) return;

    deviceList.setActive(entityId);
    const snap = twin.get(entityId);
    const data = InfoCard.fromEntity(entity, snap?.status ?? 'idle');
    data.metrics = metricsFor(snap, entity.kind);
    infoCard.show(data);
  });

  app.bus.on('pick:clear', () => {
    deviceList.setActive(null);
    infoCard.hide();
  });

  infoCard.setHandlers({
    onClose: () => interaction.selectEntity(null),
    onPartClick: (entityId, partId) => {
      const entity = world.registry.getEntity(entityId);
      const part = entity?.parts.find((p) => p.partId === partId);
      if (!part) return;
      interaction.highlighter.setSelection([part.mesh]);
      const bounds = new THREE.Box3().setFromObject(part.mesh);
      const center = bounds.getCenter(new THREE.Vector3());
      const dist = Math.max(2.4, bounds.getSize(new THREE.Vector3()).length() * 1.6);
      app.flyTo({
        position: center.clone().add(new THREE.Vector3(dist * 0.6, dist * 0.5, dist * 0.62)),
        target: center,
        duration: 0.9,
      });
    },
  });

  // ---------------- 快捷键
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;

    const preset = presets.find((p) => p.hotkey === e.key);
    if (preset) {
      applyPreset(preset.id);
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'h':
        document.body.classList.toggle('ui-hidden');
        break;
      case 'p':
        hud.toggle();
        topbar.setToolState('hud', hud.isVisible);
        break;
      case 'f':
        interaction.hotspots.setEnabled(!interaction.hotspots.isEnabled);
        break;
      case 'x': {
        // 演示用：给当前选中设备注入故障
        const sel = interaction.currentSelection;
        if (sel) twin.injectFault(sel);
        break;
      }
      case 'escape':
        interaction.selectEntity(null);
        break;
      default:
        break;
    }
  });

  // ---------------- 主循环挂钩
  app.loop.add(() => {
    binding.update();
    // 热点文案随数据更新（DOM 操作很便宜，但仍限制到 ~4Hz）
    if (performance.now() - lastHotspotRefresh > 260) {
      lastHotspotRefresh = performance.now();
      refreshHotspots(interaction, twin, world);
    }
  }, 15);

  app.loop.add(() => {
    hud.update({
      loop: app.loop.stats,
      renderer: app.renderer.snapshot(),
      tier: app.quality.tier,
      extra: { sel: interaction.currentSelection ?? '—' },
    });
  }, 100);

  let lastHotspotRefresh = 0;

  // 初始化 KPI（首帧数据还没到）
  kpiBar.set(buildKpis(twin.all(), deviceList, world));

  boot.progress(97, '编译着色器…');
  app.start();
  app.renderer.gl.compile(app.scene, app.rig.camera);

  twin.start();
  boot.done();

  const debug = import.meta.env.DEV || new URLSearchParams(location.search).has('bench');
  if (debug) {
    Object.assign(window, {
      __app: app,
      __world: world,
      __interaction: interaction,
      __presets: presets,
      __applyPreset: applyPreset,
      __bvh: bvh,
      __twin: twin,
      __THREE: THREE,
    });
  }

  window.addEventListener('beforeunload', () => {
    twin.stop();
    binding.dispose();
    interaction.dispose();
    infoCard.dispose();
    deviceList.dispose();
    kpiBar.dispose();
    alertFeed.dispose();
    hud.dispose();
    app.dispose();
  });
}

function makeAlert(
  entityId: string,
  title: string,
  level: AlertItem['level'],
  message: string,
): AlertItem {
  return {
    id: `${entityId}_${performance.now().toFixed(0)}`,
    time: clockTime(),
    entityId,
    title,
    level,
    message,
  };
}

/** 汇总 KPI（从设备快照聚合，等价于后端 OLAP 的简化版） */
function buildKpis(
  snaps: Array<{ entityId: string; status: TwinStatus; load: number; metrics: Array<{ label: string; value: string }> }>,
  deviceList: DeviceList,
  world: WorkshopWorld,
): Kpi[] {
  const total = snaps.length || 1;
  const running = snaps.filter((s) => s.status === 'running').length;
  const fault = snaps.filter((s) => s.status === 'fault').length;
  const avgLoad = snaps.reduce((acc, s) => acc + s.load, 0) / total;

  // 良率取所有检测/装配类设备的平均
  const goodRates = snaps
    .map((s) => s.metrics.find((m) => m.label === '良率')?.value)
    .filter((v): v is string => typeof v === 'string')
    .map((v) => parseFloat(v))
    .filter((v) => Number.isFinite(v));
  const avgGood = goodRates.length ? goodRates.reduce((a, b) => a + b, 0) / goodRates.length : 0;

  const oee = Math.max(0, Math.min(1, (running / total) * 0.92 * avgLoad * 1.06));

  // 产能：包装工位节拍反推（包装是产线出口）
  const packer = world.registry.listEntities().find((e) => e.kind === 'packer');
  const packerSnap = packer ? snaps.find((s) => s.entityId === packer.id) : undefined;
  const cycle = packerSnap?.metrics.find((m) => m.label === '节拍')?.value;
  const cycleNum = cycle ? parseFloat(cycle) : 18;
  const output = Math.round(3600 / Math.max(1, cycleNum));

  void deviceList;

  return [
    {
      key: 'oee',
      label: 'OEE',
      value: `${(oee * 100).toFixed(1)}`,
      unit: '%',
      tone: oee > 0.8 ? 'ok' : oee > 0.65 ? 'warn' : 'bad',
      trend: [oee * 0.94, oee * 0.97, oee * 0.95, oee],
    },
    { key: 'output', label: '理论产能', value: String(output), unit: '件/h' },
    {
      key: 'good',
      label: '平均良率',
      value: avgGood.toFixed(1),
      unit: '%',
      tone: avgGood > 98 ? 'ok' : avgGood > 96 ? 'warn' : 'bad',
    },
    {
      key: 'running',
      label: '在线设备',
      value: `${running}/${total}`,
      tone: fault > 0 ? 'warn' : 'ok',
    },
    {
      key: 'fault',
      label: '故障',
      value: String(fault),
      tone: fault > 0 ? 'bad' : 'ok',
    },
  ];
}

/** 让热点标签跟随孪生数据（8Hz 数据 / 4Hz 文案刷新） */
function refreshHotspots(
  interaction: InteractionController,
  twin: MockTwinSource,
  world: WorkshopWorld,
): void {
  interaction.updateHotspotText((entityId) => {
    const snap = twin.get(entityId);
    const entity = world.registry.getEntity(entityId);
    if (!entity) return null;
    if (!snap) return { title: entity.title, subtitle: '初始化中', tone: 'info' as const };

    const kind = entity.kind as EquipmentKind;
    const status = statusLabel(snap.status);

    // 标题用实体自身的名字（AGV #1 / 装配臂 #2 这类编号是业务信息，不能丢），
    // 副标题才承载实时指标 —— 这样即使数据在跳，标题也保持稳定可读。
    const title = `${entity.title} · ${status}`;

    // 不同设备类型的副标题关注点不同：输送带看线速，AGV 看电量，
    // 辅机（电控柜/中控台）没有节拍，只显示状态
    let subtitle = '';
    if (snap.status === 'fault') {
      subtitle = '等待处理';
    } else if (snap.status === 'maintenance') {
      subtitle = '维护中';
    } else {
      const pick = (label: string): string | undefined =>
        snap.metrics.find((m) => m.label === label)?.value;
      if (kind === 'conveyor') subtitle = `线速 ${pick('线速') ?? '—'}`;
      else if (kind === 'agv') subtitle = `电量 ${pick('电量') ?? '—'}`;
      else if (kind === 'cabinet' || kind === 'console') subtitle = pick('温度') ? `柜温 ${pick('温度')}` : '';
      else subtitle = `节拍 ${pick('节拍') ?? '—'}`;
    }

    return {
      title,
      subtitle,
      tone:
        snap.status === 'fault'
          ? ('bad' as const)
          : snap.status === 'maintenance' || snap.status === 'idle'
            ? ('warn' as const)
            : ('ok' as const),
    };
  });
}

void bootstrap().catch((err) => {
  // 兜底：任何未捕获的启动异常都必须可见，否则界面会静默卡在加载层
  console.error('[bootstrap] 未捕获异常', err);
  const msg = document.querySelector<HTMLElement>('.boot__msg');
  if (msg) {
    msg.textContent = `启动失败：${(err as Error).message}`;
    msg.style.color = 'var(--bad)';
  }
  const fill = document.querySelector('.boot__fill') as HTMLElement | null;
  if (fill) fill.style.background = 'var(--bad)';
});
