import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Renderer } from '../core/Renderer';

/**
 * 资产加载器。
 *
 * 这不是对 GLTFLoader 的简单包装，它解决四个真实问题：
 * 1. 解码器装配：Draco（几何压缩）+ KTX2/Basis（纹理）+ Meshopt，三者共用一套 loader；
 * 2. 缓存与引用计数：同一 URL 只加载一次，多个使用方各自 hold/release，
 *    引用归零才真正释放 GPU 资源（Web3D 项目最容易泄漏的地方）；
 * 3. 进度聚合：多文件并发时给出「整体进度」而不是各文件互相覆盖；
 * 4. 失败重试 + 超时：网络抖动时自动重试，避免首屏白屏。
 */
export type AssetKind = 'gltf' | 'texture' | 'json' | 'arraybuffer';

export interface LoadProgress {
  /** 已完成字节 */
  loaded: number;
  /** 总字节（未知时为 0） */
  total: number;
  /** 0..1，总字节未知时按任务数估算 */
  ratio: number;
  /** 正在加载的资源 */
  current: string;
  /** 完成的任务数 / 总任务数 */
  tasksDone: number;
  tasksTotal: number;
}

export interface LoadOptions {
  /** 加载进度回调 */
  onProgress?: (p: LoadProgress) => void;
  /** 单个资源失败重试次数，默认 2 */
  retries?: number;
  /** 单资源超时（毫秒），默认 45s */
  timeoutMs?: number;
}

interface CacheEntry<T> {
  promise: Promise<T>;
  value: T | null;
  refs: number;
}

/**
 * 解码器路径：本地优先（避免依赖外部 CDN，国内网络更稳、离线可用）。
 * 这两个目录由 `npm run assets:decoders` 从 node_modules/three 同步而来。
 * 用站点根路径而不是 import.meta.url，是因为它们放在 public/ 下，
 * 不受模块所在目录影响（dev 与 build 后路径一致）。
 */
const DRACO_DECODER_PATH = 'decoders/draco/';
const KTX2_TRANSCODER_PATH = 'decoders/basis/';

export class AssetManager {
  private readonly gltfLoader: GLTFLoader;
  private readonly dracoLoader: DRACOLoader;
  private readonly ktx2Loader: KTX2Loader;
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly disposables: Array<() => void> = [];

  private progress: LoadProgress = {
    loaded: 0,
    total: 0,
    ratio: 0,
    current: '',
    tasksDone: 0,
    tasksTotal: 0,
  };
  private onProgress: ((p: LoadProgress) => void) | undefined;

  constructor(renderer: Renderer) {
    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
    this.dracoLoader.setDecoderConfig({ type: 'wasm' });
    this.dracoLoader.preload();

    this.ktx2Loader = new KTX2Loader();
    this.ktx2Loader.setTranscoderPath(KTX2_TRANSCODER_PATH);
    this.ktx2Loader.detectSupport(renderer.gl);

    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
    this.gltfLoader.setKTX2Loader(this.ktx2Loader);
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  }

  /** 开始一批加载，重置进度统计 */
  beginBatch(onProgress?: (p: LoadProgress) => void): void {
    this.onProgress = onProgress;
    this.progress = {
      loaded: 0,
      total: 0,
      ratio: 0,
      current: '',
      tasksDone: 0,
      tasksTotal: 0,
    };
  }

  /**
   * 加载 GLTF。返回的 scene 是克隆安全的（调用方应自行 clone 后再放入场景，
   * 若只需一份实例则可直接使用）。
   */
  async loadGltf(url: string, opts: LoadOptions = {}): Promise<GLTF> {
    return this.loadWithCache<GLTF>(url, 'gltf', async () => {
      const gltf = await this.wrapWithRetry(
        () => this.gltfLoader.loadAsync(url, (evt) => this.reportBytes(url, evt)),
        opts.retries ?? 2,
        opts.timeoutMs ?? 45000,
        url,
      );
      this.configureGltf(gltf);
      return gltf;
    });
  }

  async loadTexture(
    url: string,
    opts: { colorSpace?: THREE.ColorSpace; anisotropy?: number } & LoadOptions = {},
  ): Promise<THREE.Texture> {
    return this.loadWithCache<THREE.Texture>(url, 'texture', async () => {
      const tex = await this.wrapWithRetry(
        () => this.textureLoader.loadAsync(url, (evt) => this.reportBytes(url, evt)),
        opts.retries ?? 2,
        opts.timeoutMs ?? 30000,
        url,
      );
      tex.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
      if (opts.anisotropy) tex.anisotropy = opts.anisotropy;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.needsUpdate = true;
      return tex;
    });
  }

  async loadJson<T>(url: string, opts: LoadOptions = {}): Promise<T> {
    return this.loadWithCache<T>(url, 'json', async () => {
      const res = await this.wrapWithRetry(
        async () => {
          const r = await fetch(url, { cache: 'no-cache' });
          if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
          return r.json() as Promise<T>;
        },
        opts.retries ?? 2,
        opts.timeoutMs ?? 15000,
        url,
      );
      return res;
    });
  }

  /** 释放一个引用。引用归零时真正 dispose。 */
  release<T>(url: string): void {
    const entry = this.cache.get(url) as CacheEntry<T> | undefined;
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.cache.delete(url);
    const value = entry.value;
    if (value) this.disposeValue(value);
  }

  /** 统计信息，供 HUD 展示 */
  stats(): { entries: number; refs: number } {
    let refs = 0;
    for (const e of this.cache.values()) refs += e.refs;
    return { entries: this.cache.size, refs };
  }

  dispose(): void {
    for (const entry of this.cache.values()) {
      if (entry.value) this.disposeValue(entry.value);
    }
    this.cache.clear();
    for (const fn of this.disposables) fn();
    this.disposables.length = 0;
    this.dracoLoader.dispose();
    this.ktx2Loader.dispose();
  }

  // ---------------------------------------------------------------- 内部

  private async loadWithCache<T>(
    url: string,
    kind: AssetKind,
    factory: () => Promise<T>,
  ): Promise<T> {
    const existing = this.cache.get(url) as CacheEntry<T> | undefined;
    if (existing) {
      existing.refs += 1;
      return existing.promise;
    }

    this.progress.tasksTotal += 1;
    this.progress.current = url;

    const promise = factory().then((value) => {
      const entry = this.cache.get(url) as CacheEntry<T>;
      entry.value = value;
      this.progress.tasksDone += 1;
      this.emitProgress();
      return value;
    });

    const entry: CacheEntry<T> = { promise, value: null, refs: 1 };
    this.cache.set(url, entry as CacheEntry<unknown>);
    void kind; // 预留：后续可按类型做不同缓存策略（如纹理走 LRU）

    try {
      return await promise;
    } catch (err) {
      this.cache.delete(url);
      throw err;
    }
  }

  private reportBytes(url: string, evt: ProgressEvent): void {
    if (!evt.lengthComputable) return;
    // 简化处理：以「当前任务已加载 / 当前任务总量」近似整体进度
    this.progress.loaded = evt.loaded;
    this.progress.total = evt.total;
    this.progress.current = url;
    this.emitProgress();
  }

  private emitProgress(): void {
    const { tasksDone, tasksTotal, loaded, total } = this.progress;
    let ratio: number;
    if (tasksTotal > 0 && tasksDone >= tasksTotal) {
      ratio = 1;
    } else if (total > 0) {
      // 字节进度只能代表当前文件，用任务比例做加权
      const taskRatio = tasksTotal > 0 ? tasksDone / tasksTotal : 0;
      const byteRatio = Math.min(1, loaded / total) / Math.max(1, tasksTotal);
      ratio = Math.min(0.99, taskRatio + byteRatio * 0.6);
    } else {
      ratio = tasksTotal > 0 ? tasksDone / tasksTotal : 0;
    }
    this.progress.ratio = ratio;
    this.onProgress?.({ ...this.progress });
  }

  private async wrapWithRetry<T>(
    factory: () => Promise<T>,
    retries: number,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await withTimeout(factory(), timeoutMs, label);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          const delay = 220 * Math.pow(2, attempt);
          console.warn(`[AssetManager] ${label} 第 ${attempt + 1} 次失败，${delay}ms 后重试`, err);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** GLTF 后处理：统一阴影/拾取标记，修正材质色调映射 */
  private configureGltf(gltf: GLTF): void {
    gltf.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;

      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        // glTF 的 emissive 已带 KHR_materials_emissive_strength，
        // three 会转成 emissiveIntensity；这里只确保 toneMapped 一致
        const m = mat as THREE.MeshStandardMaterial;
        if (m.isMeshStandardMaterial) {
          m.envMapIntensity = m.envMapIntensity ?? 1;
        }
        mat.side = THREE.FrontSide;
      }
    });
  }

  private disposeValue(value: unknown): void {
    const gltf = value as GLTF;
    if (gltf?.scene) {
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose?.();
      });
      return;
    }
    const tex = value as THREE.Texture;
    if (tex?.isTexture) tex.dispose();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`加载超时（${ms}ms）：${label}`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
