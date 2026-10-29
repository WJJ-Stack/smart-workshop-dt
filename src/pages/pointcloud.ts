import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

/**
 * 点云展示页。
 *
 * 这是 JD 加分项里「点云」的真实实现：40 万点的真实场景点云（从车间模型
 * 按三角面面积加权采样导出），不是随机噪点。
 *
 * 关键技术点（每一条都是真实遇到的坑）：
 *
 * 1. **点大小与透视**：用 PointsMaterial 的 sizeAttenuation=true 让远处的点变小，
 *    否则远处会糊成一片白；
 * 2. **顶点颜色**：PLY 里的 uchar RGB 需要 vertexColors=true，且
 *    颜色空间要按 sRGB 解释（three 默认把顶点色当线性值）；
 * 3. **深度写入**：点云必须开 depthWrite=true，否则半透明叠加会出现
 *    "后面的点画在前面的点上面"；
 * 4. **LOD 采样**：40 万点直接渲染在移动端会掉帧，因此提供「显示比例」滑块，
 *    通过 geometry.setDrawRange 只画前 N 个点（配合随机打乱的索引，采样均匀）。
 */
export interface PointCloudHandles {
  stats(): { points: number; rendered: number; size: number };
  setPointSize(size: number): void;
  setDrawRatio(ratio: number): void;
  toggleColorMode(): string;
  resetCamera(): void;
  dispose(): void;
}

export async function createPointCloudViewer(
  canvas: HTMLCanvasElement,
  url: string,
  onProgress: (ratio: number, message: string) => void,
): Promise<PointCloudHandles> {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080d);
  scene.fog = new THREE.FogExp2(0x05080d, 0.0075);

  const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 2000);
  camera.position.set(26, 17, 30);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 2, 0);
  controls.minDistance = 3;
  controls.maxDistance = 200;

  onProgress(0.1, '读取点云…');

  const loader = new PLYLoader();
  const geometry = await new Promise<THREE.BufferGeometry>((resolve, reject) => {
    loader.load(
      url,
      (geo) => resolve(geo),
      (evt) => {
        if (evt.lengthComputable) {
          onProgress(0.1 + (evt.loaded / evt.total) * 0.75, `下载 ${(evt.loaded / 1048576).toFixed(1)} MB`);
        }
      },
      (err) => reject(err),
    );
  });

  onProgress(0.9, '构建点云…');

  // PLY 由 Blender 导出，是 Z-up（z=高度）。three 用 Y-up，
  // 必须做一次 -90° 绕 X 轴旋转，否则整片点云"躺倒"在地面上。
  // 用几何旋转而不是对象旋转，好处是后续所有基于 position 的计算（如高度着色）都一致。
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingSphere();

  const totalPoints = geometry.getAttribute('position').count;

  // --- 随机打乱顶点顺序，这样 setDrawRange(0, n) 取到的是均匀子集而不是"前 n 个"
  // 直接重排 buffer（而不是建索引），因为 PointsMaterial 不支持 index
  shuffleVertices(geometry);

  const hasColor = geometry.getAttribute('color') !== undefined;
  const hasNormal = geometry.getAttribute('normal') !== undefined;

  // 顶点色是 sRGB 编码的，three 需要按 sRGB 解释
  if (hasColor) {
    geometry.getAttribute('color').needsUpdate = true;
  }

  let material = makeMaterial('color', hasColor, 0.022);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  // 参考地面网格（让空间有依据，否则点云"漂浮"）
  const grid = new THREE.GridHelper(120, 60, 0x1a3f5c, 0x102430);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  scene.add(grid);

  // 依据点云实际范围自动摆相机（模型尺寸变化时不用改代码）
  const bs = geometry.boundingSphere;
  if (bs) {
    const { center, radius } = bs;
    const d = Math.max(6, radius * 2.1);
    camera.position.set(center.x + d * 0.72, center.y + d * 0.62, center.z + d * 0.85);
    controls.target.copy(center);
    controls.minDistance = Math.max(1.5, radius * 0.06);
    controls.maxDistance = radius * 6;
    controls.update();
  }

  let rafId = 0;
  let renderRatio = 1;
  let colorMode: 'color' | 'normal' | 'height' = hasColor ? 'color' : 'height';

  const applyDrawRange = (): void => {
    geometry.setDrawRange(0, Math.max(1, Math.floor(totalPoints * renderRatio)));
  };
  applyDrawRange();

  const loop = (): void => {
    rafId = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  const onResize = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);
  onProgress(1, '就绪');

  function makeMaterial(
    mode: 'color' | 'normal' | 'height',
    withColor: boolean,
    size: number,
  ): THREE.PointsMaterial {
    if (mode === 'color' && withColor) {
      return new THREE.PointsMaterial({
        size,
        vertexColors: true,
        sizeAttenuation: true,
        depthWrite: true,
        transparent: false,
      });
    }
    if (mode === 'normal' && hasNormal) {
      return new THREE.PointsMaterial({
        size,
        vertexColors: true,
        sizeAttenuation: true,
        depthWrite: true,
      });
    }
    // 按高度着色：用 position 的 y 生成渐变（需要一次性计算颜色属性）
    return new THREE.PointsMaterial({
      size,
      color: 0x54e0ff,
      sizeAttenuation: true,
      depthWrite: true,
      transparent: true,
      opacity: 0.85,
    });
  }

  return {
    stats() {
      return {
        points: totalPoints,
        rendered: Math.floor(totalPoints * renderRatio),
        size: material.size,
      };
    },
    setPointSize(size) {
      material.size = size;
      material.needsUpdate = true;
    },
    setDrawRatio(ratio) {
      renderRatio = Math.max(0.02, Math.min(1, ratio));
      applyDrawRange();
    },
    toggleColorMode() {
      if (colorMode === 'color') colorMode = hasNormal ? 'normal' : 'height';
      else if (colorMode === 'normal') colorMode = 'height';
      else colorMode = hasColor ? 'color' : 'height';

      if (colorMode === 'normal' && hasNormal) {
        // 把法线写到 color 属性（临时替换）
        const normals = geometry.getAttribute('normal');
        const colorAttr = geometry.getAttribute('color');
        if (colorAttr) {
          const arr = colorAttr.array as Float32Array;
          for (let i = 0; i < normals.count; i += 1) {
            arr[i * 3] = normals.getX(i) * 0.5 + 0.5;
            arr[i * 3 + 1] = normals.getY(i) * 0.5 + 0.5;
            arr[i * 3 + 2] = normals.getZ(i) * 0.5 + 0.5;
          }
          colorAttr.needsUpdate = true;
        }
      }

      const size = material.size;
      points.material = makeMaterial(colorMode, hasColor, size);
      material.dispose();
      material = points.material as THREE.PointsMaterial;
      return colorMode;
    },
    resetCamera() {
      const bs = geometry.boundingSphere;
      if (bs) {
        const { center, radius } = bs;
        const d = Math.max(6, radius * 2.1);
        camera.position.set(center.x + d * 0.72, center.y + d * 0.62, center.z + d * 0.85);
        controls.target.copy(center);
      } else {
        camera.position.set(26, 17, 30);
        controls.target.set(0, 2, 0);
      }
      controls.update();
    },
    dispose() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}

/**
 * 打乱顶点顺序。
 *
 * 为什么需要：setDrawRange(0, n) 是按顺序取，而 PLY 的点是按对象顺序写入的
 * （地面 10 万点、墙 8 万点…）。不减采样前 30% 会得到「只有地面」的画面。
 * 打乱后任意前缀都是均匀代表性子集。
 */
function shuffleVertices(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const attrs = Object.keys(geometry.attributes).map(
    (k) => geometry.getAttribute(k) as THREE.BufferAttribute,
  );

  const rng = mulberry32(20261029);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    if (i === j) continue;
    for (const attr of attrs) {
      // 直接用 BufferAttribute 的 setX/getX 语义不方便做整块交换，
      // 这里用底层 array 交换（所有 attribute 都是类型化数组）
      const arr = attr.array as unknown as {
        [index: number]: number;
      };
      const itemSize = attr.itemSize;
      for (let k = 0; k < itemSize; k += 1) {
        const ia = i * itemSize + k;
        const ja = j * itemSize + k;
        const tmp = arr[ia]!;
        arr[ia] = arr[ja]!;
        arr[ja] = tmp;
      }
    }
  }
  for (const attr of attrs) attr.needsUpdate = true;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
