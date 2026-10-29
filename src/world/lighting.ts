import * as THREE from 'three';
import type { QualityProfile } from '../core/quality';
import type { Renderer } from '../core/Renderer';

/**
 * 环境与光照装配。
 *
 * 关键决策（面试重点）：
 * 1. 不用外部 HDR 文件，而是用 three 的 RoomEnvironment 程序化生成环境贴图，
 *    再过 PMREMGenerator 卷积成辐照度图。理由：零网络请求、体积为 0、
 *    对「设备/金属/环氧地坪」这类工业场景表现足够，且可随画质档位调分辨率。
 * 2. 主光用 DirectionalLight 并只让它在近处投射阴影，
 *    阴影相机范围按厂房尺寸收紧（过大的阴影相机 = 精度浪费 = 阴影糊）。
 * 3. 补光用低强度冷色，模拟高侧窗的漫射，避免暗部纯黑。
 * 4. 关掉 fog 与背景色的耦合：雾色单独控制，才能做出「车间纵深」。
 */
export interface LightingHandles {
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.HemisphereLight;
  envMap: THREE.Texture;
  setQuality(profile: QualityProfile): void;
  dispose(): void;
}

export function createLighting(
  scene: THREE.Scene,
  renderer: Renderer,
  profile: QualityProfile,
  hall: { length: number; width: number; height: number },
): LightingHandles {
  const group = new THREE.Group();
  group.name = 'LIGHTING';
  scene.add(group);

  // ---------------- 环境贴图（IBL）
  const pmrem = new THREE.PMREMGenerator(renderer.gl);
  pmrem.compileEquirectangularShader();
  const roomEnv = createRoomEnvironment(renderer.gl);
  const envRT = pmrem.fromScene(roomEnv, 0.04);
  const envMap = envRT.texture;
  scene.environment = envMap;
  scene.environmentIntensity = 0.85;

  // ---------------- 主光（模拟高侧窗直射）
  const key = new THREE.DirectionalLight(0xfff2e0, 2.1);
  key.position.set(hall.length * 0.35, hall.height * 1.35, hall.width * 0.4);
  key.target.position.set(0, 0, 0);
  key.castShadow = profile.shadows;
  configureShadow(key, profile.shadowMapSize, hall);
  group.add(key);
  group.add(key.target);

  // ---------------- 补光（冷色漫射）
  const fill = new THREE.DirectionalLight(0x8fc4ff, 0.62);
  fill.position.set(-hall.length * 0.45, hall.height * 0.9, -hall.width * 0.5);
  group.add(fill);

  // ---------------- 天空/地面半球光（整体环境基调）
  const rim = new THREE.HemisphereLight(0x7fa8d8, 0x1a222c, 0.85);
  group.add(rim);

  // ---------------- 灯具区域的柔和点光（少量，控制开销）
  // 只在 high 档启用，medium/low 完全靠 IBL + 两个方向光，
  // 这是「画质 vs 开销」最直接的一档取舍。
  const pointLights: THREE.PointLight[] = [];
  if (profile.tier === 'high') {
    for (let i = 0; i < 3; i += 1) {
      const p = new THREE.PointLight(0xcfe4ff, 26, 30, 2);
      p.position.set(-10 + i * 10, hall.height - 2.6, 0);
      p.castShadow = false;
      group.add(p);
      pointLights.push(p);
    }
  }

  const handles: LightingHandles = {
    key,
    fill,
    rim,
    envMap,
    setQuality(next: QualityProfile) {
      key.castShadow = next.shadows;
      if (key.shadow.mapSize.x !== next.shadowMapSize) {
        key.shadow.mapSize.set(next.shadowMapSize, next.shadowMapSize);
        key.shadow.map?.dispose();
        key.shadow.map = null;
      }
      scene.environmentIntensity = next.tier === 'low' ? 0.6 : 0.85;
      const wantPoints = next.tier === 'high';
      for (const p of pointLights) p.visible = wantPoints;
    },
    dispose() {
      key.shadow.map?.dispose();
      envRT.dispose();
      pmrem.dispose();
      roomEnv.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose?.();
      });
      group.removeFromParent();
    },
  };

  return handles;
}

function configureShadow(
  light: THREE.DirectionalLight,
  size: number,
  hall: { length: number; width: number; height: number },
): void {
  const cam = light.shadow.camera;
  // 阴影范围只覆盖厂房内部，范围越小同样分辨率下越清晰
  const halfL = hall.length * 0.62;
  const halfW = hall.width * 0.62;
  cam.left = -halfL;
  cam.right = halfL;
  cam.top = halfW;
  cam.bottom = -halfW;
  cam.near = 1;
  cam.far = hall.height * 4.5;
  cam.updateProjectionMatrix();

  light.shadow.mapSize.set(size, size);
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.035;
  light.shadow.radius = 2.2;
}

/**
 * 程序化「房间」环境：几个自发光面板围出一个盒子。
 *
 * 相比加载 HDR 的优势：体积 0、无网络、可控。
 * 相比纯 ambient light：有方向性和软阴影感，金属材质才有反射细节。
 */
function createRoomEnvironment(gl: THREE.WebGLRenderer): THREE.Scene {
  const scene = new THREE.Scene();

  const geo = new THREE.BoxGeometry();
  const room = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: 0x1a2230,
      side: THREE.BackSide,
      roughness: 1,
      metalness: 0,
    }),
  );
  room.scale.setScalar(40);
  scene.add(room);

  const panelGeo = new THREE.PlaneGeometry(1, 1);
  const makePanel = (
    color: number,
    intensity: number,
    pos: [number, number, number],
    rot: [number, number, number],
    scale: [number, number],
  ): void => {
    const mat = new THREE.MeshBasicMaterial({ color });
    mat.color.multiplyScalar(intensity);
    const panel = new THREE.Mesh(panelGeo, mat);
    panel.position.set(...pos);
    panel.rotation.set(...rot);
    panel.scale.set(scale[0], scale[1], 1);
    scene.add(panel);
  };

  // 顶部主光板（模拟厂房天窗）
  makePanel(0xffffff, 3.4, [0, 18, 0], [Math.PI / 2, 0, 0], [26, 26]);
  // 四侧柔光
  makePanel(0xbfd8ff, 1.05, [0, 2, -18], [0, 0, 0], [30, 14]);
  makePanel(0xb8d0f0, 0.85, [0, 2, 18], [0, Math.PI, 0], [30, 14]);
  makePanel(0xa8c8f0, 0.75, [-18, 3, 0], [0, Math.PI / 2, 0], [30, 14]);
  makePanel(0xa8c8f0, 0.75, [18, 3, 0], [0, -Math.PI / 2, 0], [30, 14]);
  // 地面反射板（略微冷色，压暗）
  makePanel(0x2a3444, 0.9, [0, -6, 0], [-Math.PI / 2, 0, 0], [30, 30]);

  void gl;
  return scene;
}

/**
 * 雾：让厂房远端淡出，制造纵深，同时天然遮挡远处细节，
 * 是 Web3D 里「廉价但极有效」的画面提升手段。
 */
export function applyFog(scene: THREE.Scene, hall: { length: number }): void {
  const fog = new THREE.FogExp2(0x0b1420, 0.0062);
  scene.fog = fog;
  void hall;
}

export function disposeFog(scene: THREE.Scene): void {
  scene.fog = null;
}
