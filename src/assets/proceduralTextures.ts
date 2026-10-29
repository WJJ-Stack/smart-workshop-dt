import * as THREE from 'three';

/**
 * 程序化纹理工厂。
 *
 * 为什么不全用图片：
 * 1. 零网络请求、零体积，首屏更快（这对「加载优化」是实打实的收益）；
 * 2. 可以精确控制平铺尺度与像素密度，避免拉伸；
 * 3. 灰度图 + color 着色，一套纹理复用多种材质颜色。
 *
 * 所有纹理都设置了正确的 colorSpace 与 wrap，避免常见的地面发白/接缝问题。
 */
export function makeCanvasTexture(
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  opts: { size?: number; repeat?: [number, number]; srgb?: boolean } = {},
): THREE.CanvasTexture {
  const size = opts.size ?? 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D canvas 上下文');
  draw(ctx, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 皮带纹理：横向细密橡胶纹 + 中线，做 UV 滚动时能看出方向 */
export function beltTexture(): THREE.CanvasTexture {
  return makeCanvasTexture((ctx, size) => {
    ctx.fillStyle = '#16181c';
    ctx.fillRect(0, 0, size, size);

    // 横向条纹（垂直于运动方向，滚动时形成流动感）
    const stripes = 16;
    for (let i = 0; i < stripes; i += 1) {
      const y = (i / stripes) * size;
      ctx.fillStyle = i % 2 === 0 ? '#1d2025' : '#14161a';
      ctx.fillRect(0, y, size, size / stripes);
    }

    // 细颗粒
    const grains = size * 12;
    for (let i = 0; i < grains; i += 1) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const a = Math.random() * 0.09;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect(x, y, 1, 1);
    }

    // 两侧边缘线
    ctx.strokeStyle = 'rgba(160,175,190,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 3);
    ctx.lineTo(size, 3);
    ctx.moveTo(0, size - 3);
    ctx.lineTo(size, size - 3);
    ctx.stroke();
  });
}

/** 环氧地坪：大块浅渐变 + 细噪点 + 轻微分缝 */
export function epoxyFloorTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(
    (ctx, size) => {
      const grad = ctx.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, '#20262f');
      grad.addColorStop(0.5, '#1b2029');
      grad.addColorStop(1, '#232a34');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);

      // 噪点（模拟骨料）
      const specks = size * 30;
      for (let i = 0; i < specks; i += 1) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const shade = Math.random() > 0.5 ? 255 : 0;
        ctx.fillStyle = `rgba(${shade},${shade},${shade},${Math.random() * 0.05})`;
        ctx.fillRect(x, y, 1, 1);
      }

      // 分缝
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, size / 2);
      ctx.lineTo(size, size / 2);
      ctx.moveTo(size / 2, 0);
      ctx.lineTo(size / 2, size);
      ctx.stroke();
    },
    { repeat: [12, 8] },
  );
}

/** 混凝土场地：更粗的颗粒与色差 */
export function concreteTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(
    (ctx, size) => {
      ctx.fillStyle = '#3a3d42';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < size * 40; i += 1) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const v = Math.random() > 0.5 ? 255 : 20;
        ctx.fillStyle = `rgba(${v},${v},${v},${Math.random() * 0.055})`;
        ctx.fillRect(x, y, 1, 1);
      }
      // 裂缝
      ctx.strokeStyle = 'rgba(20,20,22,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      let px = Math.random() * size;
      let py = 0;
      ctx.moveTo(px, py);
      while (py < size) {
        px += (Math.random() - 0.5) * 26;
        py += Math.random() * 22;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    },
    { repeat: [18, 14] },
  );
}

/** 金属拉丝：竖向细线，用于设备外壳 */
export function brushedMetalTexture(): THREE.CanvasTexture {
  return makeCanvasTexture(
    (ctx, size) => {
      ctx.fillStyle = '#8a9099';
      ctx.fillRect(0, 0, size, size);
      for (let x = 0; x < size; x += 1) {
        const a = Math.random() * 0.1;
        const v = Math.random() > 0.5 ? 255 : 0;
        ctx.fillStyle = `rgba(${v},${v},${v},${a})`;
        ctx.fillRect(x, 0, 1, size);
      }
    },
    { repeat: [2, 2] },
  );
}

/** 发光面板：屏幕内容（网格 + 数据条），给中控台一点信息感 */
export function screenTexture(): THREE.CanvasTexture {
  return makeCanvasTexture((ctx, size) => {
    ctx.fillStyle = '#04202e';
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(80,200,255,0.16)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i += 1) {
      const p = (i / 8) * size;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    // 数据条
    for (let r = 0; r < 5; r += 1) {
      const y = size * 0.2 + r * size * 0.13;
      const w = size * (0.25 + Math.random() * 0.55);
      ctx.fillStyle = 'rgba(90,210,255,0.55)';
      ctx.fillRect(size * 0.1, y, w, size * 0.045);
    }

    // 折线
    ctx.strokeStyle = 'rgba(120,240,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let y = size * 0.78;
    ctx.moveTo(size * 0.08, y);
    for (let x = size * 0.08; x < size * 0.92; x += size * 0.08) {
      y += (Math.random() - 0.5) * size * 0.12;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}
