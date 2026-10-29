import type { AssetManifest } from '../assets/manifest';

/**
 * 从 public 加载 manifest。
 * manifest 由 Blender 管线生成，是前端唯一信任的资产事实来源。
 */
export async function loadManifest(baseUrl: string): Promise<AssetManifest> {
  const res = await fetch(`${baseUrl}manifest.json`, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`manifest 加载失败: HTTP ${res.status}。请先运行 npm run assets`);
  }
  const json = (await res.json()) as AssetManifest;
  if (!json || json.version !== 1) {
    throw new Error('manifest 版本不匹配，请重新运行资产构建');
  }
  return json;
}
