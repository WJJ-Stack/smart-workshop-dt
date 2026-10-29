import * as THREE from 'three';
import type { QualityProfile } from './quality';
import type { Viewport } from './Viewport';

/**
 * 渲染器封装：集中所有 WebGLRenderer 的配置与能力探测。
 *
 * 关键点（面试可讲）：
 * - outputColorSpace = SRGB + ACESFilmic 色调映射，保证 PBR 材质正确出光；
 * - shadowMap 类型与尺寸由画质档位决定，low 档直接关闭实时阴影；
 * - 主动探测 WebGL2 扩展，决定是否启用 KTX2 压缩纹理与实例化特性；
 * - 提供 info 快照（drawcall / 三角面 / 显存估算）给性能 HUD。
 */
export interface RendererCapabilities {
  webgl2: boolean;
  maxTextureSize: number;
  maxAnisotropy: number;
  floatTextures: boolean;
  bptc: boolean;
  etc2: boolean;
  astc: boolean;
}

export interface RendererInfoSnapshot {
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  programs: number;
  geometries: number;
  textures: number;
  /** 估算纹理显存占用（MB） */
  textureMemoryMB: number;
}

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly capabilities: RendererCapabilities;

  private readonly viewport: Viewport;
  private profile: QualityProfile;
  private readonly textures = new Set<THREE.Texture>();

  constructor(viewport: Viewport, profile: QualityProfile) {
    this.viewport = viewport;
    this.profile = profile;

    this.gl = new THREE.WebGLRenderer({
      canvas: viewport.canvas,
      antialias: profile.tier !== 'low',
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });

    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = profile.shadows;
    this.gl.shadowMap.type = profile.tier === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.gl.shadowMap.autoUpdate = true;
    this.gl.autoClear = true;
    this.gl.setClearColor(0x070b12, 1);

    this.capabilities = this.probe(profile.maxAnisotropy);
    this.applyViewport();
  }

  private probe(maxAnisotropyHint: number): RendererCapabilities {
    const gl = this.gl.getContext() as WebGL2RenderingContext;
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const maxAnisotropy = Math.min(
      maxAnisotropyHint,
      this.gl.capabilities.getMaxAnisotropy(),
    );

    return {
      webgl2: isWebGL2,
      maxTextureSize,
      maxAnisotropy,
      floatTextures: isWebGL2 || !!gl.getExtension('OES_texture_float_linear'),
      bptc: isWebGL2 && !!gl.getExtension('EXT_texture_compression_bptc'),
      etc2: !!gl.getExtension('WEBGL_compressed_texture_etc'),
      astc: !!gl.getExtension('WEBGL_compressed_texture_astc'),
    };
  }

  /** 应用 Viewport 的尺寸与像素比 */
  applyViewport(): void {
    const { width, height, pixelRatio } = this.viewport.current;
    this.gl.setPixelRatio(pixelRatio);
    this.gl.setSize(width, height, false);
  }

  setProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.gl.shadowMap.enabled = profile.shadows;
    this.gl.shadowMap.type = profile.tier === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    // 关闭阴影后需要让已编译的材质重新编译
    this.gl.shadowMap.needsUpdate = true;
  }

  get quality(): QualityProfile {
    return this.profile;
  }

  /** 追踪纹理，便于估算显存与统一销毁 */
  trackTexture(texture: THREE.Texture): THREE.Texture {
    this.textures.add(texture);
    return texture;
  }

  untrackTexture(texture: THREE.Texture): void {
    this.textures.delete(texture);
  }

  snapshot(): RendererInfoSnapshot {
    const info = this.gl.info;
    let textureMemoryMB = 0;
    for (const tex of this.textures) {
      const image = tex.image as { width?: number; height?: number } | undefined;
      const w = image?.width ?? 0;
      const h = image?.height ?? 0;
      if (w && h) textureMemoryMB += (w * h * 4) / (1024 * 1024);
    }
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      textureMemoryMB,
    };
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.gl.render(scene, camera);
  }

  resetInfo(): void {
    this.gl.info.reset();
  }

  dispose(): void {
    for (const tex of this.textures) tex.dispose();
    this.textures.clear();
    this.gl.dispose();
  }
}
