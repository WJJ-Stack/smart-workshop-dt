import * as THREE from 'three';
import type { FrameInfo } from '../core/Loop';
import type { QualityProfile } from '../core/quality';
import type { World, WorldContext } from '../App';
import { AssetManager } from '../assets/AssetManager';
import { readDt, type AssetManifest, type EquipmentKind, type EquipmentMeta } from '../assets/manifest';
import { applyFog, createLighting, type LightingHandles } from './lighting';
import { enhanceMaterials, type MaterialEnhanceResult } from './materialEnhance';
import { createPostFx, type PostFxHandles } from './postfx';
import { LodManager, sceneMetrics } from './LodManager';
import { EntityRegistry, type Entity } from '../entities/EntityRegistry';

/**
 * 车间主世界。
 *
 * 职责：
 * 1. 加载 manifest 与 GLB，装配场景；
 * 2. 从节点命名中解析出「实体 → 部件」层级，注册到 EntityRegistry；
 * 3. 驱动 AnimationMixer（设备动作）与程序化动画（传送带 UV）；
 * 4. 画质变化时重建受影响的资源。
 *
 * 刻意不做的事：拾取、高亮、UI。那些是独立系统，通过 EntityRegistry 与事件总线接入，
 * 保证「世界数据」与「交互行为」解耦。
 */
export interface WorkshopOptions {
  manifest: AssetManifest;
  baseUrl: string;
  onProgress?: (ratio: number, message: string) => void;
  /** 初始画质档位（LOD 切换后重建材质时需要） */
  qualityDefault?: QualityProfile;
}

export class WorkshopWorld implements World {
  readonly registry = new EntityRegistry();

  private readonly opts: WorkshopOptions;
  private assets!: AssetManager;
  private lighting: LightingHandles | null = null;
  private materials: MaterialEnhanceResult | null = null;
  private postfx: PostFxHandles | null = null;
  private lodManager: LodManager | null = null;
  private sceneCenter = new THREE.Vector3();
  /** 记录当前画质，LOD 切换重建材质时要用 */
  private lastProfile: QualityProfile | null = null;

  /** 公开只读访问，供调试与性能面板量化 LOD 行为 */
  get lod(): LodManager | null {
    return this.lodManager;
  }
  private readonly root = new THREE.Group();
  private modelRoot: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();

  /** 程序化动画：传送带皮带 UV 滚动 */
  private readonly beltMaterials = new Set<THREE.MeshStandardMaterial>();
  private beltOffset = 0;
  /** 相机位置缓存（LOD 判定用） */
  private readonly ctxCameraPos = new THREE.Vector3();

  constructor(opts: WorkshopOptions) {
    this.opts = opts;
    this.root.name = 'WORKSHOP';
  }

  get sceneRoot(): THREE.Group {
    return this.root;
  }

  get animationClips(): string[] {
    return [...this.actions.keys()];
  }

  async build(ctx: WorldContext): Promise<void> {
    ctx.scene.add(this.root);
    this.lastProfile = ctx.quality;

    this.assets = new AssetManager(ctx.renderer);
    const hall = this.opts.manifest.hall;

    this.report(0.05, '装配光照环境…');
    this.lighting = createLighting(ctx.scene, ctx.renderer, ctx.quality, hall);
    applyFog(ctx.scene, hall);

    this.assets.beginBatch((p) => {
      this.report(0.08 + p.ratio * 0.9, `加载模型 ${Math.round(p.ratio * 100)}%`);
    });

    const modelUrl = `${this.opts.baseUrl}${this.lodFile(0)}`;
    const gltf = await this.assets.loadGltf(modelUrl);

    this.report(0.94, '构建实体索引…');
    this.modelRoot = gltf.scene;
    this.modelRoot.name = 'WORKSHOP_MODEL';
    this.root.add(this.modelRoot);

    this.indexEntities(gltf);
    this.setupAnimations(gltf);
    this.collectProcedural(this.modelRoot);

    this.report(0.97, '增强材质…');
    this.materials = enhanceMaterials(this.modelRoot, ctx.quality);

    const metrics = sceneMetrics(this.modelRoot);
    this.sceneCenter.copy(metrics.center);

    this.report(0.99, '启用后处理…');
    this.postfx = createPostFx(ctx.renderer.glRenderer, ctx.scene, ctx.rig.camera, ctx.quality);
    ctx.app.setPostFx(this.postfx);

    // LOD 管理器：首屏只用 LOD0，其余按需加载
    this.lodManager = new LodManager({
      scene: ctx.scene,
      baseUrl: this.opts.baseUrl,
      manifest: this.opts.manifest,
      assets: this.assets,
      container: this.root,
      initialLevel: 0,
      onSwitched: (level) => {
        // 换模型后必须重建索引，否则 registry 还指向已卸载的旧 mesh，
        // 拾取、高亮、热点全部失效（这是 LOD 最隐蔽的坑）
        this.rebuildIndexForLevel(level);
      },
    });

    this.report(1, '就绪');
    ctx.bus.emit('resize', {
      width: ctx.app.viewport.current.width,
      height: ctx.app.viewport.current.height,
      pixelRatio: ctx.app.viewport.current.pixelRatio,
    });
  }

  /**
   * 建立实体索引。
   *
   * 遍历一遍场景，把 P_<entity>__<part> 挂到对应 EQ_<entity> 上。
   * 结果供拾取系统用：raycast 命中任何 mesh，都能 O(1) 查到它属于哪台设备、
   * 是哪个部件、以及该设备的业务元数据。
   */
  private indexEntities(gltf: { scene: THREE.Object3D }): void {
    const equipmentRoots = new Map<string, THREE.Object3D>();

    gltf.scene.traverse((obj) => {
      const dt = readDt(obj.userData as Record<string, unknown>);
      if (dt?.kind && dt.kind !== 'env' && dt.group !== 'env' && obj.name.startsWith('EQ_')) {
        equipmentRoots.set(obj.name, obj);
      }
    });

    let partCount = 0;
    gltf.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;

      const name = obj.name;
      if (!name.startsWith('P_')) {
        // 静态合并件：仍登记为可拾取（点地面/墙体给出环境反馈）
        if (name.startsWith('MERGED_')) {
          this.registry.registerStatic(mesh);
        }
        return;
      }

      const sep = name.indexOf('__');
      if (sep === -1) return;
      const entityName = name.slice(2, sep);
      const partName = name.slice(sep + 2);

      const rootObj = equipmentRoots.get(entityName) ?? obj.parent;
      const rootDt = rootObj ? readDt(rootObj.userData as Record<string, unknown>) : null;
      const partDt = readDt(obj.userData as Record<string, unknown>);
      const meta = this.opts.manifest.equipment[entityName];

      this.registry.registerPart({
        entityId: entityName,
        partId: partName,
        mesh,
        root: rootObj ?? mesh,
        kind: (meta?.kind ?? (rootDt?.kind as EquipmentKind) ?? 'cabinet') as EquipmentKind,
        title: meta?.title ?? rootDt?.title ?? entityName,
        station: meta?.station ?? (rootDt?.station as number | undefined) ?? 0,
        role: partDt?.role,
        joint: partDt?.joint,
      });
      partCount += 1;
    });

    console.info(
      `[WorkshopWorld] 实体 ${this.registry.entityCount} 个，可拾取部件 ${partCount} 个，` +
        `静态合并件 ${this.registry.staticCount} 个`,
    );
  }

  private setupAnimations(gltf: { animations: THREE.AnimationClip[] }): void {
    if (gltf.animations.length === 0) return;
    this.mixer = new THREE.AnimationMixer(this.modelRoot!);

    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.play();
      this.actions.set(clip.name, action);
    }
    console.info(`[WorkshopWorld] 动画 ${gltf.animations.length} 个：`, [...this.actions.keys()].join(', '));
  }

  /** 收集需要程序化驱动的材质（传送带 UV） */
  private collectProcedural(rootObj: THREE.Object3D): void {
    rootObj.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const dt = readDt(obj.userData as Record<string, unknown>);
      if (!dt?.uv_scroll) return;

      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat?.isMeshStandardMaterial) return;
      // 克隆材质，避免同一材质被多段皮带共享导致速度互相覆盖
      const cloned = mat.clone();
      cloned.name = `${mat.name}_belt`;
      mesh.material = cloned;
      this.beltMaterials.add(cloned);
    });
    console.info(`[WorkshopWorld] 皮带材质 ${this.beltMaterials.size} 个`);
  }

  update(frame: FrameInfo): void {
    this.mixer?.update(frame.delta);

    // 皮带流动：UV 偏移比逐帧移动顶点便宜得多，且不产生额外 drawcall
    if (this.beltMaterials.size > 0) {
      this.beltOffset = (this.beltOffset + frame.delta * 0.55) % 1;
      for (const mat of this.beltMaterials) {
        if (!mat.map) continue;
        mat.map.offset.x = -this.beltOffset;
      }
    }

    this.lodManager?.update(frame, this.ctxCameraPos, this.sceneCenter);
  }

  /** 由 App 每帧注入相机位置（避免 WorkshopWorld 直接持有相机引用） */
  setCameraPosition(pos: THREE.Vector3): void {
    this.ctxCameraPos.copy(pos);
  }

  onQualityChange(profile: QualityProfile): void {
    this.lastProfile = profile;
    this.lighting?.setQuality(profile);
    this.materials?.setQuality(profile);
    this.postfx?.setQuality(profile);
    this.lodManager?.setEnabled(profile.tier !== 'low');
    if (profile.tier === 'low') this.lodManager?.prefetch(2);
  }

  private lodFile(level: number): string {
    const entry = this.opts.manifest.lods.find((l) => l.level === level);
    return entry?.file ?? 'workshop.glb';
  }

  /** 外部（main.ts）注册，用于 LOD 切换后重绑 BVH 与高亮 */
  private levelChangedHandler: ((level: number, registry: EntityRegistry) => void) | null = null;

  onLevelChanged(fn: (level: number, registry: EntityRegistry) => void): void {
    this.levelChangedHandler = fn;
  }

  /**
   * LOD 切换后重建实体索引。
   *
   * 必须做，否则 registry 还指向已被移出场景的旧 mesh，
   * 拾取会命中不可见对象、高亮修改的是孤儿材质 —— 这是 LOD 最隐蔽的 bug。
   *
   * 另外：新 LOD 模型由 Decimate 生成，不含动画轨道，
   * 所以 AnimationMixer 继续绑定在 LOD0 上（远处本来也看不清关节动作）。
   */
  private rebuildIndexForLevel(level: number): void {
    let current: THREE.Object3D | null = null;
    for (const child of this.root.children) {
      if (child.name.startsWith('WORKSHOP_MODEL')) {
        current = child;
        break;
      }
    }
    if (!current) return;

    this.registry.dispose();
    this.indexEntities({ scene: current });

    // 新模型的材质是独立实例，程序化贴图需要重新应用
    this.materials?.dispose();
    this.materials = null;
    const profile = this.lastProfile ?? this.opts.qualityDefault;
    if (profile) this.materials = enhanceMaterials(current, profile);

    this.levelChangedHandler?.(level, this.registry);
    console.info(
      `[WorkshopWorld] LOD${level} 索引重建：${this.registry.entityCount} 实体 / ` +
        `${this.registry.allInteractiveMeshes().length} 部件`,
    );
  }

  private report(ratio: number, message: string): void {
    this.opts.onProgress?.(ratio, message);
  }

  /** 供外部（相机/路径）查询的实体列表 */
  listEquipment(): Array<{ id: string; meta: EquipmentMeta; root: THREE.Object3D }> {
    return this.registry.listEntities().map((e: Entity) => ({
      id: e.id,
      meta: { kind: e.kind, title: e.title, station: e.station },
      root: e.root,
    }));
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();

    this.lighting?.dispose();
    this.lighting = null;

    this.materials?.dispose();
    this.materials = null;

    this.lodManager?.dispose();
    this.lodManager = null;
    this.postfx = null;

    // 皮带材质是克隆出来的，必须单独释放
    for (const mat of this.beltMaterials) {
      mat.map?.dispose();
      mat.dispose();
    }
    this.beltMaterials.clear();

    this.registry.dispose();
    this.assets?.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.modelRoot = null;
  }
}

