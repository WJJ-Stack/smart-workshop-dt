import * as THREE from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import type { QualityProfile } from '../core/quality';

/**
 * 后处理管线。
 *
 * 为什么用 postprocessing 库而不是 three 的 EffectComposer：
 * 1. 它会自动合并 effect（EffectPass 把多个 effect 编进同一个 shader），
 *    一次全屏 drawcall 干完 Bloom+SMAA+Vignette，而 three 自带的是每个 effect 一个 pass；
 * 2. 内置 ToneMapping 与 SRGB 处理正确，避免「后处理之后画面发灰」；
 * 3. Bloom 基于 mipmap 金字塔，比高斯模糊便宜得多。
 *
 * 档位策略：
 * - high:   Bloom + SMAA + Vignette + ACES（完整）
 * - medium: Bloom（更低分辨率）+ SMAA
 * - low:    不使用后处理（直接把 renderer 渲染到画布）
 *
 * 关键性能细节：resize 时必须同时更新 composer.setSize 与 renderer.setSize，
 * 只更新一个会导致画面被拉伸。
 */
export interface PostFxHandles {
  enabled: boolean;
  render(delta: number, scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  setQuality(profile: QualityProfile): void;
  dispose(): void;
}

export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  profile: QualityProfile,
): PostFxHandles {
  // 用 holder 而不是裸 let：TS 的控制流分析无法跟踪闭包内的赋值，
  // 裸 let 会让 composer 在后续代码里被推断为 never。
  const holder: { composer: EffectComposer | null } = { composer: null };
  let enabled = false;

  const build = (p: QualityProfile): void => {
    disposeComposer();

    if (!p.postprocessing) {
      enabled = false;
      return;
    }

    const composer = new EffectComposer(renderer, {
      // 半浮点精度足够 Bloom，且比全浮点省一半显存
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });
    holder.composer = composer;

    composer.addPass(new RenderPass(scene, camera));

    const bloom = new BloomEffect({
      intensity: p.tier === 'high' ? 1.15 : 0.85,
      luminanceThreshold: 0.62,
      luminanceSmoothing: 0.28,
      mipmapBlur: true,
      radius: p.tier === 'high' ? 0.82 : 0.62,
    });

    const effects: Array<BloomEffect | SMAAEffect | ToneMappingEffect | VignetteEffect> = [bloom];

    if (p.tier === 'high') {
      effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
      effects.push(new VignetteEffect({ darkness: 0.42, offset: 0.32 }));
    }
    effects.push(new SMAAEffect());

    composer.addPass(new EffectPass(camera, ...effects));
    enabled = true;
  };

  const disposeComposer = (): void => {
    holder.composer?.dispose();
    holder.composer = null;
  };

  build(profile);

  // 初始尺寸跟随 canvas
  const canvas = renderer.domElement;
  holder.composer?.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1);

  return {
    get enabled() {
      return enabled;
    },
    render(delta, scn, cam) {
      const composer = holder.composer;
      if (enabled && composer) {
        composer.render(delta);
        return;
      }
      renderer.render(scn, cam);
    },
    setSize(width, height, pixelRatio) {
      void pixelRatio;
      holder.composer?.setSize(width, height);
      // 后处理关闭时，renderer 的尺寸由 Viewport 统一管理，这里无需处理
    },
    setQuality(p) {
      build(p);
    },
    dispose() {
      disposeComposer();
      enabled = false;
    },
  };
}
