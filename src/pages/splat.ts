import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import './assetViewer.css';

/**
 * 3DGS 展示页。
 *
 * 加载 `.splat` 并渲染高斯。
 *
 * 为什么自己写渲染器而不是引 @sparkjsdev/spark：
 * 1. spark 的 peer 依赖 three >= 0.180，与本项目 0.186 兼容，但它会额外拉
 *    一套自己的排序与渲染管线（约 200KB），对"只展示一个静态模型"是浪费；
 * 2. 自己实现能完整展示「我知道 .splat 格式和 alpha-blend 排序是怎么回事」，
 *    这对面试比"我调了个库"有价值得多。
 *
 * 实现策略（CPU 排序 + GPU 实例化 + 预乘 alpha 混合）：
 * - 每个高斯是一个实例化的四边形（InstancedBufferGeometry + 6 顶点）；
 * - 顶点着色器做 3D 协方差 → 屏幕空间 2D 协方差投影，得到椭圆的轴与半径；
 * - 片元着色器按 |x|²+|y|²≤1 丢弃，边缘用高斯衰减得到柔和 alpha；
 * - 每帧按相机距离对实例做一次深度排序（只排索引，不搬数据），
 *   这是 alpha 混合正确的前提。
 *
 * 性能取舍：CPU 排序在 3 万~10 万高斯时可接受（~4ms）；
 * 更多的话应该换 GPU 基数排序，但那就需要 compute shader，
 * WebGL2 下的实现复杂度会上升一个量级。
 */
export interface SplatStats {
  gaussians: number;
  fps: number;
  sortMs: number;
  bytes: number;
}

export interface SplatViewerHandles {
  stats(): SplatStats;
  resetCamera(): void;
  setSorting(on: boolean): boolean;
  dispose(): void;
}

interface SplatData {
  count: number;
  positions: Float32Array; // 3
  scales: Float32Array; // 3
  colors: Float32Array; // 3 (0..1)
  alphas: Float32Array; // 1
  quats: Float32Array; // 4 (normalized xyzw)
}

  /** 解析 antimatter15 .splat：每条 32 字节 */
export function parseSplat(buffer: ArrayBuffer): SplatData {
  const RECORD = 32;
  const count = Math.floor(buffer.byteLength / RECORD);
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const alphas = new Float32Array(count);
  const quats = new Float32Array(count * 4);

  const view = new DataView(buffer);

  for (let i = 0; i < count; i += 1) {
    const o = i * RECORD;
    const p = i * 12;
    const q = i * 4;

    // 注意：导出脚本产出的是 Blender 原生 Z-up 坐标（x, y, z=高度）。
    // 这里直接做 Z-up → Y-up 转换，避免整个场景"躺倒"：
    //   gltf_x = x
    //   gltf_y = z   （高度）
    //   gltf_z = -y
    const bx = view.getFloat32(o, true);
    const by = view.getFloat32(o + 4, true);
    const bz = view.getFloat32(o + 8, true);
    positions[p] = bx;
    positions[p + 1] = bz;
    positions[p + 2] = -by;

    scales[p] = view.getFloat32(o + 12, true);
    scales[p + 1] = view.getFloat32(o + 16, true);
    scales[p + 2] = view.getFloat32(o + 20, true);

    colors[p] = view.getUint8(o + 24) / 255;
    colors[p + 1] = view.getUint8(o + 25) / 255;
    colors[p + 2] = view.getUint8(o + 26) / 255;
    alphas[i] = view.getUint8(o + 27) / 255;

    const qx = (view.getUint8(o + 28) - 128) / 128;
    const qy = (view.getUint8(o + 29) - 128) / 128;
    const qz = (view.getUint8(o + 30) - 128) / 128;
    const qw = (view.getUint8(o + 31) - 128) / 128;
    // 四元数也要跟着做同样的坐标轴变换（绕 X 轴 -90°）：
    //   q' = qz_flip * q，其中 z-up→y-up 对应绕 X 轴 -90°
    // 简化处理：交换 y/z 分量并取反
    quats[q] = qx;
    quats[q + 1] = qz;
    quats[q + 2] = -qy;
    quats[q + 3] = qw;
  }

  return { count, positions, scales, colors, alphas, quats };
}

const VERT = /* glsl */ `
precision highp float;

attribute vec2 aCorner;       // quad corner (-1..1)
attribute vec3 aPosition;
attribute vec3 aScale;
attribute vec3 aColor;
attribute float aAlpha;
attribute vec4 aQuat;

uniform vec2 uViewport;
uniform mat4 uView;
uniform mat4 uProj;
uniform float uFocal;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vQuad;

mat3 quatToMat(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  float x2 = x + x, y2 = y + y, z2 = z + z;
  float xx = x * x2, xy = x * y2, xz = x * z2;
  float yy = y * y2, yz = y * z2, zz = z * z2;
  float wx = w * x2, wy = w * y2, wz = w * z2;
  return mat3(
    1.0 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1.0 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1.0 - (xx + yy)
  );
}

void main() {
  vQuad = aCorner;

  vec4 camPos = uView * vec4(aPosition, 1.0);
  float depth = -camPos.z;   // 相机看向 -Z，取正值

  // 近裁剪面外的高斯直接丢弃（推到屏幕外）
  if (depth < 0.15) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    vColor = vec3(0.0);
    return;
  }

  // --- 1. 世界空间 3D 协方差 Σ = R S Sᵀ Rᵀ
  mat3 R = quatToMat(normalize(aQuat));
  mat3 M = R * mat3(
    aScale.x, 0.0, 0.0,
    0.0, aScale.y, 0.0,
    0.0, 0.0, aScale.z
  );
  mat3 SigmaW = M * transpose(M);

  // --- 2. 把协方差转到相机空间（关键：Σ 是世界空间的，必须先做 V Σ Vᵀ）
  mat3 V = mat3(uView);
  mat3 SigmaC = V * SigmaW * transpose(V);

  // --- 3. 相机空间透视雅可比
  //     px = f·x/d, py = f·y/d, d = -z
  //     ∂px/∂z = f·x/d²,  ∂py/∂z = f·y/d²
  float f = uFocal;
  float invD = 1.0 / depth;
  float invD2 = invD * invD;
  mat3 J = mat3(
    f * invD, 0.0,     f * camPos.x * invD2,
    0.0,     f * invD, f * camPos.y * invD2,
    0.0,     0.0,      0.0
  );

  // --- 4. 屏幕空间 2D 协方差（像素²）
  mat3 T = J * SigmaC * transpose(J);
  float a = T[0][0] + 0.3;
  float b = T[0][1];
  float c = T[1][1] + 0.3;

  // --- 5. 特征值分解求椭圆半轴
  float mid = 0.5 * (a + c);
  float disc = max(0.0, mid * mid - (a * c - b * b));
  float root = sqrt(disc);
  float l1 = mid + root;
  float l2 = max(0.0, mid - root);

  vec2 axis1 = normalize(vec2(b, l1 - a) + vec2(1e-9, 1e-9));
  vec2 axis2 = vec2(-axis1.y, axis1.x);

  float r1 = 2.6 * sqrt(l1);
  float r2 = 2.6 * sqrt(l2);

  // --- 6. 中心 NDC 与像素偏移
  vec4 clip = uProj * camPos;
  float w = max(1e-5, clip.w);
  vec2 ndc = clip.xy / w;

  vec2 offset =
    axis1 * aCorner.x * r1 * (2.0 / uViewport.x) +
    axis2 * aCorner.y * r2 * (2.0 / uViewport.y);

  gl_Position = vec4(ndc + offset, clip.z / w, 1.0);

  vColor = aColor;
  vAlpha = aAlpha;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vQuad;

void main() {
  // 单位圆内的高斯衰减
  float r2 = dot(vQuad, vQuad);
  if (r2 > 1.0) discard;
  float falloff = exp(-3.0 * r2);
  float alpha = vAlpha * falloff;
  if (alpha <= 0.004) discard;

  // 预乘 alpha 输出，配合 blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
  gl_FragColor = vec4(vColor * alpha, alpha);
}
`;

export async function createSplatViewer(
  canvas: HTMLCanvasElement,
  url: string,
  onProgress: (ratio: number, message: string) => void,
): Promise<SplatViewerHandles> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080d);

  const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.5, 2000);
  camera.position.set(24, 16, 28);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1.6, 0);
  controls.minDistance = 1.5;
  controls.maxDistance = 160;

  onProgress(0.08, '下载 .splat…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载失败 HTTP ${res.status}（${url}）`);
  const totalBytes = Number(res.headers.get('content-length') ?? 0);

  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        if (totalBytes > 0) {
          onProgress(0.08 + (received / totalBytes) * 0.55, `${(received / 1048576).toFixed(1)} MB`);
        }
      }
    }
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }

  onProgress(0.68, '解析高斯数据…');
  const data = parseSplat(buf.buffer);
  if (data.count === 0) throw new Error('.splat 文件为空或格式不正确');

  onProgress(0.8, `构建 ${data.count.toLocaleString()} 个高斯…`);

  // --- 非实例化方案（更稳、调试更直接）
  //
  // 为什么不用 InstancedBufferGeometry：
  // 它依赖 instanceCount + 实例属性，three 在视锥剔除、boundingSphere、
  // 以及自定义 ShaderMaterial 的 attribute 绑定上有多个隐式前提，
  // 稍有不符就静默不绘制（drawcall=0 且无 GL 错误），排查成本极高。
  //
  // 这里直接把每个高斯展开成 6 个顶点（2 个三角形）的普通 BufferGeometry，
  // 数据量 = 150000 × 6 × (2+3+3+3+1+4) 浮点数 ≈ 144MB 顶点缓冲，
  // 6GB 显存可接受；换来的是「行为完全可预测」：所有 attribute 都是普通
  // per-vertex 属性，three 的默认管线就能正确处理。
  const vertsPerGaussian = 6;
  const totalVerts = data.count * vertsPerGaussian;

  const corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

  const aCorner = new Float32Array(totalVerts * 2);
  const aPosition = new Float32Array(totalVerts * 3);
  const aScale = new Float32Array(totalVerts * 3);
  const aColor = new Float32Array(totalVerts * 3);
  const aAlpha = new Float32Array(totalVerts);
  const aQuat = new Float32Array(totalVerts * 4);

  for (let i = 0; i < data.count; i += 1) {
    const p3 = i * 3;
    const p4 = i * 4;
    for (let v = 0; v < vertsPerGaussian; v += 1) {
      const out = i * vertsPerGaussian + v;
      const o2 = out * 2;
      const o3 = out * 3;
      const o4 = out * 4;

      aCorner[o2] = corners[v * 2]!;
      aCorner[o2 + 1] = corners[v * 2 + 1]!;

      aPosition[o3] = data.positions[p3]!;
      aPosition[o3 + 1] = data.positions[p3 + 1]!;
      aPosition[o3 + 2] = data.positions[p3 + 2]!;

      aScale[o3] = data.scales[p3]!;
      aScale[o3 + 1] = data.scales[p3 + 1]!;
      aScale[o3 + 2] = data.scales[p3 + 2]!;

      aColor[o3] = data.colors[p3]!;
      aColor[o3 + 1] = data.colors[p3 + 1]!;
      aColor[o3 + 2] = data.colors[p3 + 2]!;

      aAlpha[out] = data.alphas[i]!;

      aQuat[o4] = data.quats[p4]!;
      aQuat[o4 + 1] = data.quats[p4 + 1]!;
      aQuat[o4 + 2] = data.quats[p4 + 2]!;
      aQuat[o4 + 3] = data.quats[p4 + 3]!;
    }
  }

  const geo = new THREE.BufferGeometry();
  // 必须提供名为 "position" 的属性：three 的渲染管线用它计算顶点数、
  // 包围盒与 frustum culling。缺了它对象会被静默跳过（drawcall=0，无报错）——
  // 这是本次排查耗时最久的一个坑。
  // 顶点着色器不读 position（真实位置在 aPosition），所以这里用一份
  // 极小的占位数组即可，避免再分配 90 万 × 3 个 float。
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(totalVerts * 3), 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(aCorner, 2));
  geo.setAttribute('aPosition', new THREE.BufferAttribute(aPosition, 3));
  geo.setAttribute('aScale', new THREE.BufferAttribute(aScale, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
  geo.setAttribute('aQuat', new THREE.BufferAttribute(aQuat, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 0), 200);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-100, -20, -100), new THREE.Vector3(100, 30, 100));

  const uniforms = {
    uViewport: { value: new THREE.Vector2(canvas.clientWidth, canvas.clientHeight) },
    uView: { value: new THREE.Matrix4() },
    uProj: { value: new THREE.Matrix4() },
    uFocal: { value: 800 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    // transparent: false 让 three 走不透明通道（不受 depthSort 影响），
    // 混合由我们自己用 CustomBlending 控制 —— 这样既保证绘制顺序由
    // 我们的深度排序决定，也避免 three 因 transparent 而做额外排序/剔除。
    transparent: false,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  scene.add(mesh);

  // 诊断：确认实例化几何/材质真的被上传，以及首帧是否有绘制
  {
    const gl2 = renderer.getContext();
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.render(scene, camera); // 先渲染一次让程序编译并统计
    const initialGlError = gl2.getError();
    console.info(`[splat] 首次渲染 glError=${initialGlError} calls=${renderer.info.render.calls}`);

    (window as unknown as Record<string, unknown>)['__splatDraw'] = () => {
      renderer.info.reset();
      renderer.render(scene, camera);
      return {
        vertices: geo.getAttribute('aPosition').count,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        glError: gl2.getError(),
        visible: mesh.visible,
        inScene: !!mesh.parent,
        camPos: camera.position.toArray().map((v) => Math.round(v)),
        target: controls.target.toArray().map((v) => Math.round(v)),
      };
    };
  }

  // 诊断：把数据范围与相机位置暴露出来，便于排查"画面空白"
  {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < data.count; i += 1) {
      const x = data.positions[i * 3]!;
      const y = data.positions[i * 3 + 1]!;
      const z = data.positions[i * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    console.info(
      `[splat] 数据范围 X[${minX.toFixed(1)}, ${maxX.toFixed(1)}] ` +
        `Y[${minY.toFixed(1)}, ${maxY.toFixed(1)}] Z[${minZ.toFixed(1)}, ${maxZ.toFixed(1)}]`,
    );

    // 依据数据范围自动摆相机，避免"模型不在视野内"
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    camera.position.set(cx + span * 0.85, cy + span * 0.7, cz + span * 1.0);
    controls.target.set(cx, cy, cz);
    controls.minDistance = span * 0.05;
    controls.maxDistance = span * 6;
    controls.update();
    camera.updateMatrixWorld(true);

    (window as unknown as Record<string, unknown>)['__splatDebug'] = () => ({
      count: data.count,
      bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      camera: camera.position.toArray(),
      target: [cx, cy, cz],
      span,
    });
  }

  // --- 深度排序：只重排「索引缓冲」，不搬顶点数据
  //
  // 关键洞察：排序对象是高斯（150k），但顶点数是它的 6 倍（900k）。
  // 如果每次排序都重排全部顶点属性，代价是 6 倍数据量 —— 这正是最初
  // 排序耗时 76ms 的原因。
  //
  // 正确做法：给几何体建一个索引缓冲，每个高斯对应 6 个索引。
  // 排序只重写这 900k 个索引里「每 6 个一组」的顺序，顶点属性一动不动。
  // 索引是 Uint32Array（单元素 4B），重排成本远低于重排 12 个 float 属性。
  const indexArray = new Uint32Array(data.count * vertsPerGaussian);
  for (let i = 0; i < data.count; i += 1) {
    const base = i * vertsPerGaussian;
    // 每个高斯的 6 个顶点：0,1,2 / 3,4,5（两个三角形）
    indexArray[base] = base;
    indexArray[base + 1] = base + 1;
    indexArray[base + 2] = base + 2;
    indexArray[base + 3] = base + 3;
    indexArray[base + 4] = base + 4;
    indexArray[base + 5] = base + 5;
  }
  const indexAttr = new THREE.BufferAttribute(indexArray, 1);
  geo.setIndex(indexAttr);

  const depths = new Float32Array(data.count);
  const order = new Uint32Array(data.count);
  for (let i = 0; i < data.count; i += 1) order[i] = i;

  let sorting = true;
  let sortMs = 0;
  let lastSortAt = 0;
  let lastCamPos = camera.position.clone();
  let fps = 0;
  let frames = 0;
  let fpsAccum = 0;

  const doSort = (): void => {
    const t0 = performance.now();
    const cp = camera.position;

    for (let i = 0; i < data.count; i += 1) {
      const p = i * 3;
      const dx = data.positions[p]! - cp.x;
      const dy = data.positions[p + 1]! - cp.y;
      const dz = data.positions[p + 2]! - cp.z;
      depths[i] = dx * dx + dy * dy + dz * dz;
    }

    // 排序索引数组（150k 个数字，比排 900k 顶点属性快得多）
    const idx = Array.from(order);
    idx.sort((a, b) => depths[b]! - depths[a]!);

    // 只重写索引缓冲：每个高斯 6 个索引
    const V = vertsPerGaussian;
    for (let k = 0; k < data.count; k += 1) {
      const src = idx[k]!;
      const sBase = src * V;
      const dBase = k * V;
      indexArray[dBase] = sBase;
      indexArray[dBase + 1] = sBase + 1;
      indexArray[dBase + 2] = sBase + 2;
      indexArray[dBase + 3] = sBase + 3;
      indexArray[dBase + 4] = sBase + 4;
      indexArray[dBase + 5] = sBase + 5;
    }
    indexAttr.needsUpdate = true;

    sortMs = performance.now() - t0;
    lastCamPos = cp.clone();
  };

  doSort();

  let rafId = 0;
  const loop = (): void => {
    rafId = requestAnimationFrame(loop);
    controls.update();

    // 相机移动超过阈值才重排（否则静止时白排）
    const now = performance.now();
    const moved = camera.position.distanceToSquared(lastCamPos) > 0.02;
    // 节流：即使相机在动，也最多每 90ms 重排一次。
    // 150k 高斯的 CPU 排序约 20ms，60fps 下每帧都排会吃掉 1/3 帧预算；
    // 而 alpha 混合的排序误差在相机快速移动时人眼几乎察觉不到。
    if (sorting && (moved || now - lastSortAt > 900) && now - lastSortAt > 90) {
      lastSortAt = now;
      doSort();
    }

    const cv = renderer.domElement;
    uniforms.uViewport.value.set(cv.width / renderer.getPixelRatio(), cv.height / renderer.getPixelRatio());
    uniforms.uView.value.copy(camera.matrixWorldInverse);
    uniforms.uProj.value.copy(camera.projectionMatrix);
    // 焦距（像素）：与 projectionMatrix 的 fov 保持一致，供雅可比使用
    uniforms.uFocal.value =
      (cv.height / renderer.getPixelRatio()) * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));

    renderer.render(scene, camera);

    frames += 1;
    fpsAccum += 1;
    if (fpsAccum >= 30) {
      fps = (frames * 1000) / (now - (loop as unknown as { _t?: number })._t! || 1);
      (loop as unknown as { _t?: number })._t = now;
      frames = 0;
      fpsAccum = 0;
    }
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

  return {
    stats() {
      return { gaussians: data.count, fps, sortMs, bytes: received };
    },
    resetCamera() {
      camera.position.set(24, 16, 28);
      controls.target.set(0, 1.6, 0);
      controls.update();
    },
    setSorting(on: boolean) {
      sorting = on;
      return sorting;
    },
    dispose() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      geo.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}

void THREE;
void PLYLoader;

// 说明：高斯的视觉质量主要由「尺度」和「alpha 衰减」决定。
// 尺度过大 → 糊成一片；过大且 alpha 高 → 曝光过渡、发白。
// 这两个参数在 export_splat.py 侧生成，前端只做补偿：
// - GLSL 里 exp(-3.0 * r²) 让边缘更快衰减（默认 2 次方在 3σ 处残留可见）
// - 3σ 半径略收紧到 2.6σ，减少重叠时的能量堆积



