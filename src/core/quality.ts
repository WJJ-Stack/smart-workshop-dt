/**
 * 画质档位：单一真相来源。
 * 所有后续模块（阴影、后处理、DPR、纹理尺寸、粒子数）都从档位推导，
 * 而不是各处硬编码 if-else。
 */
export type QualityTier = 'high' | 'medium' | 'low';

export interface QualityProfile {
  tier: QualityTier;
  /** 设备像素比上限 */
  maxPixelRatio: number;
  /** 主阴影贴图边长 */
  shadowMapSize: number;
  /** 是否启用后处理 */
  postprocessing: boolean;
  /** 是否启用环境光遮蔽 */
  ssao: boolean;
  /** 环境立方体贴图采样分辨率（IBL） */
  envResolution: number;
  /** 各向异性过滤上限 */
  maxAnisotropy: number;
  /** 是否启用实时阴影 */
  shadows: boolean;
  /** 粒子/实例数量缩放 */
  densityScale: number;
}

const PROFILES: Record<QualityTier, Omit<QualityProfile, 'tier' | 'maxAnisotropy'>> = {
  high: {
    maxPixelRatio: 2,
    shadowMapSize: 2048,
    postprocessing: true,
    ssao: true,
    envResolution: 256,
    shadows: true,
    densityScale: 1,
  },
  medium: {
    maxPixelRatio: 1.5,
    shadowMapSize: 1024,
    postprocessing: true,
    ssao: false,
    envResolution: 128,
    shadows: true,
    densityScale: 0.7,
  },
  low: {
    maxPixelRatio: 1,
    shadowMapSize: 512,
    postprocessing: false,
    ssao: false,
    envResolution: 64,
    shadows: false,
    densityScale: 0.4,
  },
};

const TIER_ORDER: readonly QualityTier[] = ['high', 'medium', 'low'];

export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === 'string' && (TIER_ORDER as readonly string[]).includes(value);
}

/**
 * 自动判定档位。
 * 依据：屏幕像素密度 + 逻辑核心数 + 是否被判定为移动端 UA。
 * 允许 URL `?q=high|medium|low` 强制覆盖，便于验收和性能对比实验。
 */
export function detectQualityTier(search: string = window.location.search): QualityTier {
  const forced = new URLSearchParams(search).get('q');
  if (isQualityTier(forced)) return forced;

  const dpr = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 720;

  if (coarse || smallScreen) return cores >= 8 && dpr <= 3 ? 'medium' : 'low';
  if (cores >= 8 && dpr >= 1.25) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

export function resolveProfile(tier: QualityTier, maxAnisotropy: number): QualityProfile {
  return { tier, ...PROFILES[tier], maxAnisotropy };
}

export function lowerTier(tier: QualityTier): QualityTier {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(i + 1, TIER_ORDER.length - 1)] ?? 'low';
}
