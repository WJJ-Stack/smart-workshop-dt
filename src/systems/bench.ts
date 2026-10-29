import * as THREE from 'three';
import type { App } from '../App';
import type { WorkshopWorld } from '../world/WorkshopWorld';

/**
 * 性能基准（在页面内运行，结果可导出为 JSON）。
 *
 * 为什么必须在页面内跑：
 * 1. 只有页面里才能拿到真实的 App / 场景 / 相机 / GL 上下文；
 * 2. 用 readPixels 强制 GPU 同步，测的才是「渲染完成时间」而不是「命令提交时间」；
 * 3. 首帧有 shader 编译与纹理上传，必须先 warmup 再采样，否则数字虚高。
 *
 * 输出结构刻意与 tools/render_perf.mjs 的期望一致。
 */
export interface BenchSample {
  medianMs: number;
  p95Ms: number;
  fps: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  programs: number;
}

export interface BenchReport {
  env: { gpu: string; dpr: number; canvas: { w: number; h: number }; tier: string };
  noPostFx: BenchSample;
  withPostFx: BenchSample;
  tiers: Record<string, BenchSample>;
  pickingParts: {
    bvhPerPickMs: number;
    plainPerPickMs: number;
    speedup: number;
    triangles: number;
  } | null;
  pickingStatic: {
    bvhPerPickMs: number;
    plainPerPickMs: number;
    speedup: number;
    triangles: number;
  } | null;
  culling: { total: number; visible: number; culled: number; ratioPct: number } | null;
  lod: { level: number; switches: number; loadMs: number } | null;
  loadMs: number;
  loadBytes: number;
}

export async function runBench(
  app: App,
  world: WorkshopWorld,
  opts: { samples?: number } = {},
): Promise<BenchReport> {
  const n = opts.samples ?? 40;
  const gl = app.renderer.glRenderer;
  const ctx = gl.getContext();
  const px = new Uint8Array(4);

  const sync = (): void => {
    ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
  };

  // composer 内部有多个 pass，会反复 reset info；
  // 关掉 autoReset 后手动控制，才能读到「一次完整场景渲染」的真实统计。
  gl.info.autoReset = false;

  const drawFrame = (): void => {
    gl.info.reset();
    const fx = app.currentPostFx;
    if (fx && fx.enabled) fx.render(1 / 60, app.scene, app.rig.camera);
    else gl.render(app.scene, app.rig.camera);
  };

  const measure = (count: number): BenchSample => {
    // warmup：让着色器编译、纹理上传、后处理 FBO 分配都完成
    for (let i = 0; i < 8; i += 1) drawFrame();
    sync();

    const samples: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const t0 = performance.now();
      drawFrame();
      sync();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? 0;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? median;
    const info = app.renderer.snapshot();
    return {
      medianMs: round(median, 2),
      p95Ms: round(p95, 2),
      fps: round(1000 / Math.max(0.001, median), 1),
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      textures: info.textures,
      programs: info.programs,
    };
  };

  const report: BenchReport = {
    env: {
      gpu: detectGpu(ctx),
      dpr: window.devicePixelRatio,
      canvas: { w: gl.domElement.width, h: gl.domElement.height },
      tier: app.quality.tier,
    },
    noPostFx: { medianMs: 0, p95Ms: 0, fps: 0, drawCalls: 0, triangles: 0, textures: 0, programs: 0 },
    withPostFx: { medianMs: 0, p95Ms: 0, fps: 0, drawCalls: 0, triangles: 0, textures: 0, programs: 0 },
    tiers: {},
    pickingParts: null,
    pickingStatic: null,
    culling: null,
    lod: null,
    loadMs: 0,
    loadBytes: 0,
  };

  // --- 1. 关后处理基线
  const fx = app.currentPostFx;
  const hadFx = fx?.enabled ?? false;
  if (fx) fx.setQuality({ ...app.quality, postprocessing: false });
  report.noPostFx = measure(n);

  // --- 2. 开后处理
  if (fx && hadFx) fx.setQuality(app.quality);
  report.withPostFx = fx?.enabled ? measure(n) : report.noPostFx;

  // --- 3. 三档画质
  for (const tier of ['high', 'medium', 'low'] as const) {
    app.setQuality(tier);
    await frameDelay();
    report.tiers[tier] = measure(n);
  }
  app.setQuality('high');
  await frameDelay();

  // --- 4. 拾取：BVH vs 朴素（分小网格组与大合批件组，结论不同）
  const partTargets = world.registry.allInteractiveMeshes();
  const staticTargets: THREE.Mesh[] = [];
  world.sceneRoot.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && o.name.startsWith('MERGED_')) staticTargets.push(mesh);
  });

  const measurePicking = (
    label: string,
    targets: THREE.Mesh[],
  ): { bvhPerPickMs: number; plainPerPickMs: number; speedup: number; triangles: number } | null => {
    if (targets.length === 0) return null;
    const rcBvh = new THREE.Raycaster();
    rcBvh.firstHitOnly = true;
    const rcPlain = new THREE.Raycaster();
    const saved = targets.map((m) => m.raycast);
    const N = 120;

    const run = (rc: THREE.Raycaster): void => {
      for (let i = 0; i < N; i += 1) {
        const k = i / N;
        rc.setFromCamera(new THREE.Vector2(-0.8 + k * 1.6, 0.35 - k * 0.7), app.rig.camera);
        rc.intersectObjects(targets, false);
      }
    };

    // 朴素：换回 three 原生逐三角面实现（含 warmup，避免 JIT 偏差）
    for (const m of targets) m.raycast = THREE.Mesh.prototype.raycast;
    run(rcPlain);
    const t1 = performance.now();
    run(rcPlain);
    const plainMs = (performance.now() - t1) / N;

    // BVH：恢复加速实现
    targets.forEach((m, i) => {
      m.raycast = saved[i]!;
    });
    run(rcBvh);
    const t0 = performance.now();
    run(rcBvh);
    const bvhMs = (performance.now() - t0) / N;

    let tris = 0;
    for (const m of targets) {
      const geo = m.geometry;
      tris += geo.index ? geo.index.count / 3 : (geo.attributes['position']?.count ?? 0) / 3;
    }

    // 恢复（幂等）
    targets.forEach((m, i) => {
      m.raycast = saved[i]!;
    });

    void label;
    return {
      bvhPerPickMs: round(bvhMs, 3),
      plainPerPickMs: round(plainMs, 3),
      speedup: round(plainMs / Math.max(0.0001, bvhMs), 1),
      triangles: Math.round(tris),
    };
  };

  report.pickingParts = measurePicking('parts', partTargets);
  report.pickingStatic = measurePicking('static', staticTargets);

  // --- 5. 视锥剔除率
  {
    const frustum = new THREE.Frustum();
    const m = new THREE.Matrix4().multiplyMatrices(
      app.rig.camera.projectionMatrix,
      app.rig.camera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(m);
    let total = 0;
    let visible = 0;
    const sphere = new THREE.Sphere();
    world.sceneRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !o.visible) return;
      total += 1;
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      const bs = mesh.geometry.boundingSphere;
      if (!bs) return;
      sphere.copy(bs).applyMatrix4(mesh.matrixWorld);
      if (frustum.intersectsSphere(sphere)) visible += 1;
    });
    report.culling = {
      total,
      visible,
      culled: total - visible,
      ratioPct: round((1 - visible / Math.max(1, total)) * 100, 1),
    };
  }

  // --- 6. LOD 状态
  const lod = world.lod;
  if (lod) {
    report.lod = { level: lod.level, switches: lod.stats.switches, loadMs: lod.stats.loadMs };
  }

  // --- 7. 首屏加载耗时：只统计 LOD0 主模型（其它 LOD 是后台预取，不该混进来）
  {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const main = entries.filter(
      (e) => e.name.includes('workshop.glb') && !e.name.includes('lod'),
    );
    const first = main[0];
    report.loadMs = first ? round(first.duration, 0) : 0;
    report.loadBytes = first ? first.encodedBodySize : 0;
  }

  gl.info.autoReset = true;
  return report;
}

function detectGpu(ctx: WebGL2RenderingContext | WebGLRenderingContext): string {
  const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
  if (!dbg) return 'unknown';
  return String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
}

function round(v: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function frameDelay(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/** 把报告渲染成 Markdown 表格，直接贴进 PERF.md */
export function reportToMarkdown(r: BenchReport): string {
  const row = (label: string, s: BenchSample): string =>
    `| ${label} | ${s.medianMs} | ${s.p95Ms} | ${s.fps} | ${s.drawCalls} | ${s.triangles.toLocaleString()} | ${s.textures} |`;

  return [
    '| 配置 | 中位帧耗时 (ms) | p95 (ms) | 等效 FPS | drawcall | 三角面 | 纹理 |',
    '|---|---|---|---|---|---|---|',
    row('关闭后处理', r.noPostFx),
    row('开启 Bloom+SMAA', r.withPostFx),
    row('画质 high', r.tiers['high'] ?? r.withPostFx),
    row('画质 medium', r.tiers['medium'] ?? r.withPostFx),
    row('画质 low', r.tiers['low'] ?? r.withPostFx),
  ].join('\n');
}
