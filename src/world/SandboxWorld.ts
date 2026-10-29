import * as THREE from 'three';
import type { FrameInfo } from '../core/Loop';
import type { QualityProfile } from '../core/quality';
import type { World, WorldContext } from '../App';

/**
 * M1 阶段的世界：只做渲染内核验证。
 * 内容刻意保持最小 —— 一个地面网格、一个受光的 PBR 球、一个转动体，
 * 目的是确认「色彩空间 / 色调映射 / 阴影 / 尺寸响应 / 循环顺序」全链路正确。
 * M2 起会被 WorkshopWorld 取代，本文件保留为可切换的调试场景。
 */
export class SandboxWorld implements World {
  private ctx!: WorldContext;
  private readonly group = new THREE.Group();
  private spinner: THREE.Mesh | null = null;
  private shadowLight: THREE.DirectionalLight | null = null;
  private spin = 0;

  async build(ctx: WorldContext): Promise<void> {
    this.ctx = ctx;
    ctx.scene.add(this.group);

    this.buildLights();
    this.buildGround();
    this.buildShowcase();
  }

  private buildLights(): void {
    const ambient = new THREE.HemisphereLight(0x9fc4ff, 0x1b2530, 0.9);
    this.group.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(18, 26, 14);
    key.castShadow = this.ctx.quality.shadows;
    const size = this.ctx.quality.shadowMapSize;
    key.shadow.mapSize.set(size, size);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 120;
    key.shadow.camera.left = -34;
    key.shadow.camera.right = 34;
    key.shadow.camera.top = 34;
    key.shadow.camera.bottom = -34;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.03;
    this.group.add(key);
    this.shadowLight = key;

    const fill = new THREE.DirectionalLight(0x5fa8ff, 0.55);
    fill.position.set(-16, 10, -18);
    this.group.add(fill);
  }

  private buildGround(): void {
    const grid = new THREE.GridHelper(200, 100, 0x2a4a6a, 0x16283a);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.7;
    this.group.add(grid);

    const planeGeo = new THREE.PlaneGeometry(200, 200);
    const planeMat = new THREE.MeshStandardMaterial({
      color: 0x141c26,
      roughness: 0.94,
      metalness: 0.02,
    });
    const plane = new THREE.Mesh(planeGeo, planeMat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.01;
    plane.receiveShadow = true;
    this.group.add(plane);
  }

  private buildShowcase(): void {
    const bodyGeo = new THREE.CylinderGeometry(1.4, 1.6, 3.2, 48, 1);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x9aa7b5,
      roughness: 0.4,
      metalness: 0.85,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 1.6;
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    const ringGeo = new THREE.TorusGeometry(2.4, 0.16, 20, 96);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x3fa9ff,
      roughness: 0.25,
      metalness: 0.3,
      emissive: 0x1b6fb5,
      emissiveIntensity: 2.2,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 3.6;
    ring.castShadow = true;
    this.group.add(ring);

    this.spinner = ring;
  }

  update(frame: FrameInfo): void {
    this.spin += frame.delta * 0.7;
    const s = this.spinner;
    if (s) {
      s.rotation.z = this.spin;
      s.position.y = 3.6 + Math.sin(this.spin * 1.6) * 0.18;
    }
  }

  onQualityChange(profile: QualityProfile): void {
    const light = this.shadowLight;
    if (!light) return;
    light.castShadow = profile.shadows;
    const size = profile.shadowMapSize;
    if (light.shadow.mapSize.x !== size) {
      light.shadow.mapSize.set(size, size);
      light.shadow.map?.dispose();
      light.shadow.map = null;
    }
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.group.removeFromParent();
    this.group.clear();
    this.spinner = null;
    this.shadowLight = null;
  }
}
