import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

/**
 * 3D Tiles 演示页：真实瓦片流式加载。
 *
 * 这个页面存在的意义是证明「不是引个库摆样子」：
 * 1. tileset.json 由 tools/blender/build_tiles.py 真实切分生成（12 单元 × 2 级 LOD）；
 * 2. 网络面板能看到随相机移动按需请求瓦片（进视野才加载）；
 * 3. 有实时统计：已加载瓦片数 / 待加载 / 请求字节 / 可见三角面。
 *
 * 与主场景的关键差异：这里用 3d-tiles-renderer 的调度器，
 * 由它决定什么时候请求哪些瓦片，我们只提供相机与屏幕空间误差阈值。
 */
export interface TilesStats {
  visible: number;
  active: number;
  /** 已加载的内容数 */
  requests: number;
  /** 正在下载 */
  downloading: number;
  /** 累计下载字节 */
  bytes: number;
}

export interface TilesViewerHandles {
  stats(): TilesStats;
  setGeometricError(err: number): void;
  reset(): void;
  dispose(): void;
}

export async function createTilesViewer(
  canvas: HTMLCanvasElement,
  baseUrl: string,
  onStats: (s: TilesStats) => void,
): Promise<TilesViewerHandles> {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b12);
  scene.fog = new THREE.FogExp2(0x070b12, 0.0015);

  const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.5, 3000);
  // 厂房 40×28×7.6m。这个机位让整个厂房大致铺满视野，
  // 且 errorTarget=16 下会加载多个瓦片（既能看清结构，又能观察瓦片调度）。
  camera.position.set(46, 34, 50);
  camera.lookAt(0, 3, 0);
  camera.updateMatrixWorld(true);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 3, 0);
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 6;
  controls.maxDistance = 260;
  controls.update();

  // --- 光照
  scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1b2530, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(40, 60, 30);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const sc = key.shadow.camera;
  sc.left = -50;
  sc.right = 50;
  sc.top = 50;
  sc.bottom = -50;
  sc.near = 1;
  sc.far = 200;
  scene.add(key);

  // 地面参考（瓦片加载不出来时也能看出空间尺度）
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 0.92, metalness: 0.02 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);
  scene.add(new THREE.GridHelper(400, 80, 0x1e3a55, 0x14202c));

  // --- 3D Tiles
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('decoders/draco/');

  const ktx2Loader = new KTX2Loader();
  ktx2Loader.setTranscoderPath('decoders/basis/');
  ktx2Loader.detectSupport(renderer);

  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);
  gltfLoader.setKTX2Loader(ktx2Loader);

  // 注意：必须传**完整路径**，且库会把 rootURL 的目录名去掉（用 basePath 作为相对基准），
  // 所以这里显式指定完整 URL。之前的 bug 是传了 `${base}tileset.json`，
  // 库把 `tiles/` 目录剥掉后变成 `assets/tileset.json` → 404 HTML → JSON 解析失败。
  const tilesetUrl = new URL(`${baseUrl}tiles/tileset.json`, location.href).href;
  const tiles = new TilesRenderer(tilesetUrl);
  renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);
  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.setCamera(camera);
  tiles.manager.addHandler(/\.glb$/i, gltfLoader);
  tiles.manager.addHandler(/\.gltf$/i, gltfLoader);
  scene.add(tiles.group);

  // 事件追踪：把内部加载链路的每一步都记下来，便于定位"为什么没瓦片"
  const events: string[] = [];
  const errors: string[] = [];
  for (const evt of ['load-tileset', 'load-error', 'needs-update', 'load-content', 'dispose-content']) {
    tiles.addEventListener(evt as never, (e: unknown) => {
      events.push(evt);
      if (events.length > 200) events.shift();
      if (evt === 'load-error') {
        const detail = e as { error?: Error; url?: string };
        errors.push(`${detail?.url ?? '?'} :: ${detail?.error?.message ?? String(detail?.error ?? '?')}`);
        console.error('[tiles] load-error', detail?.url, detail?.error);
      }
    });
  }
  (window as unknown as Record<string, unknown>)['__tilesEvents'] = () => events.slice(-30);
  (window as unknown as Record<string, unknown>)['__tilesErrors'] = () => errors.slice(-10);

  // 诊断钩子（放在 window 上便于排查，也方便演示时讲清内部状态）
  type Internals = {
    rootLoadingState?: number;
    rootTileset?: unknown;
    stats?: unknown;
    queuedTiles?: unknown[];
  };
  const internals = tiles as unknown as Internals;

  const diag = {
    rootLoadingState: () => internals.rootLoadingState,
    rootTileset: () => (internals.rootTileset ? 'loaded' : 'null'),
    visible: () => tiles.visibleTiles.size,
    stats: () => internals.stats,
    errorTarget: () => tiles.errorTarget,
    queued: () => internals.queuedTiles?.length ?? -1,
    cameras: () => (tiles as unknown as { cameras: unknown[] }).cameras.length,
    groupChildren: () => tiles.group.children.length,
  };
  (window as unknown as Record<string, unknown>)['__tilesDiag'] = diag;
  // 允许外部手动驱动一次更新（用于自动化排查：非活跃标签页 rAF 会被节流）
  (window as unknown as Record<string, unknown>)['__tilesUpdate'] = () => {
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    renderer.render(scene, camera);
    return { state: internals.rootLoadingState, visible: tiles.visibleTiles.size };
  };

  tiles.addEventListener('load-tileset', (e: { tileset?: unknown }) => {
    console.info('[tiles] load-tileset', e?.tileset ? 'ok' : 'empty');
  });
  tiles.addEventListener('load-error', (e: { error?: Error }) => {
    console.error('[tiles] load-error', e?.error);
  });

  // --- 瓦片请求统计（库本身不暴露 queued/stats，自己挂事件统计）
  const counters = { requests: 0, bytes: 0, downloading: 0 };

  tiles.addEventListener('load-tile-set', () => {
    console.info('[tiles] tileset 已加载');
  });
  tiles.addEventListener('load-content', () => {
    counters.requests += 1;
  });

  const originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const isTile = /\.(glb|b3dm|pnts|cmpt|i3dm)$/i.test(url);
    if (!isTile) return originalFetch(input, init);

    counters.downloading += 1;
    try {
      const res = await originalFetch(input, init);
      // 只统计字节数，不消费原始 body（res.clone 之后原响应仍可用）
      res
        .clone()
        .arrayBuffer()
        .then((buf) => {
          counters.bytes += buf.byteLength;
        })
        .catch(() => undefined);
      return res;
    } finally {
      counters.downloading = Math.max(0, counters.downloading - 1);
    }
  };

  let rafId = 0;
  let lastStatsAt = 0;

  const loop = (): void => {
    rafId = requestAnimationFrame(loop);
    controls.update();
    tiles.setCamera(camera);
    tiles.update();
    renderer.render(scene, camera);

    const now = performance.now();
    if (now - lastStatsAt > 300) {
      lastStatsAt = now;
      onStats({
        visible: tiles.visibleTiles.size,
        active: tiles.activeTiles.size,
        requests: counters.requests,
        downloading: counters.downloading,
        bytes: counters.bytes,
      });    }
  };
  loop();

  const onResize = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    tiles.setResolutionFromRenderer(camera, renderer);
  };
  window.addEventListener('resize', onResize);

  return {
    stats() {
      return {
        visible: tiles.visibleTiles.size,
        active: tiles.activeTiles.size,
        requests: counters.requests,
        downloading: counters.downloading,
        bytes: counters.bytes,
      };
    },
    setGeometricError(err: number) {
      tiles.errorTarget = err;
      tiles.update();
    },
    reset() {
      camera.position.set(46, 34, 50);
      controls.target.set(0, 3, 0);
      controls.update();
    },
    dispose() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      window.fetch = originalFetch;
      tiles.dispose();
      controls.dispose();
      dracoLoader.dispose();
      ktx2Loader.dispose();
      renderer.dispose();
    },
  };
}
