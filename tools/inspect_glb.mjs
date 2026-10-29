/**
 * GLB 结构检查器：不依赖 three.js，直接解析 GLB 容器与 JSON chunk。
 *
 * 用途：
 * 1. 验证导出产物是否包含预期的动画、extras 元数据、节点命名；
 * 2. 统计网格/材质/图元数量，定位「体积大头」在哪；
 * 3. 作为 CI 里的资产断言（命名规范、必须有动画等）。
 *
 * 用法：node tools/inspect_glb.mjs public/assets/models/workshop.glb
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const GLB_MAGIC = 0x46546c67; // 'glTF'

export function parseGlb(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) throw new Error('不是合法的 GLB 文件');
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);

  let offset = 12;
  let json = null;
  let binLength = 0;

  while (offset < totalLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;

    if (chunkType === 0x4e4f534a) {
      const text = new TextDecoder('utf-8').decode(
        new Uint8Array(buffer.buffer, buffer.byteOffset + dataStart, chunkLength),
      );
      json = JSON.parse(text);
    } else if (chunkType === 0x004e4942) {
      binLength = chunkLength;
    }
    offset = dataStart + chunkLength;
  }

  return { version, json, binLength, totalLength };
}

function summarize(path) {
  const buffer = readFileSync(path);
  const { json, binLength } = parseGlb(buffer);

  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const prims = meshes.reduce((n, m) => n + (m.primitives?.length ?? 0), 0);
  const materials = json.materials ?? [];
  const animations = json.animations ?? [];
  const extensions = json.extensionsUsed ?? [];

  // --- 命名规范校验
  const eqNodes = nodes.filter((n) => n.name?.startsWith('EQ_'));
  const partNodes = nodes.filter((n) => n.name?.startsWith('P_'));
  const envNodes = nodes.filter((n) => n.name?.startsWith('ENV_'));
  const badNames = nodes.filter(
    (n) => n.name && !/^(EQ_|P_|ENV_|COL_)/.test(n.name) && n.mesh === undefined,
  );

  // --- dt 元数据覆盖率
  const withDt = nodes.filter((n) => n.extras?.dt);
  const dtKinds = {};
  for (const n of withDt) {
    const dt = typeof n.extras.dt === 'string' ? JSON.parse(n.extras.dt) : n.extras.dt;
    const kind = dt.kind ?? 'none';
    dtKinds[kind] = (dtKinds[kind] ?? 0) + 1;
  }

  // --- 体量分布
  const accessors = json.accessors ?? [];
  let vertexCount = 0;
  let indexCount = 0;
  const perMesh = [];
  for (const mesh of meshes) {
    let tris = 0;
    let verts = 0;
    for (const prim of mesh.primitives ?? []) {
      const posAcc = accessors[prim.attributes?.POSITION];
      if (posAcc) verts += posAcc.count;
      const idxAcc = prim.indices !== undefined ? accessors[prim.indices] : null;
      if (idxAcc) tris += idxAcc.count / 3;
      else if (posAcc) tris += posAcc.count / 3;
    }
    vertexCount += verts;
    indexCount += tris * 3;
    perMesh.push({ name: mesh.name, tris: Math.round(tris), verts });
  }
  perMesh.sort((a, b) => b.tris - a.tris);

  console.log(`\n=== ${basename(path)} ===`);
  console.log(`file      : ${(buffer.length / 1024).toFixed(1)} KB  (bin chunk ${(binLength / 1024).toFixed(1)} KB)`);
  console.log(`generator : ${json.asset?.generator ?? '?'}`);
  console.log(`extensions: ${extensions.length ? extensions.join(', ') : '(none)'}`);
  console.log(`nodes     : ${nodes.length}   meshes: ${meshes.length}   primitives: ${prims}`);
  console.log(`materials : ${materials.length}   animations: ${animations.length}`);
  console.log(`vertices  : ${vertexCount.toLocaleString()}   triangles: ${Math.round(indexCount / 3).toLocaleString()}`);
  console.log(
    `naming    : EQ_=${eqNodes.length}  P_=${partNodes.length}  ENV_=${envNodes.length}  bad=${badNames.length}`,
  );
  console.log(`dt extras : ${withDt.length} nodes  ${JSON.stringify(dtKinds)}`);

  if (animations.length) {
    console.log(`\nanimations:`);
    for (const anim of animations) {
      const channels = anim.channels?.length ?? 0;
      const samplers = anim.samplers?.length ?? 0;
      const inputAcc = samplers > 0 ? accessors[anim.samplers[0].input] : null;
      const dur = inputAcc?.max?.[0];
      console.log(`  - ${anim.name}: ${channels} channels, ${samplers} samplers, dur=${dur ?? '?'}s`);
    }
  }

  console.log(`\ntop meshes by triangles:`);
  for (const m of perMesh.slice(0, 8)) {
    console.log(`  ${String(m.tris).padStart(6)}  ${m.name}`);
  }

  const issues = [];
  if (badNames.length) issues.push(`${badNames.length} 个节点命名不符合规范`);
  if (withDt.length === 0) issues.push('没有任何 dt 元数据（export_extras 可能未生效）');
  if (animations.length === 0) issues.push('没有动画');
  console.log(issues.length ? `\n⚠ ISSUES: ${issues.join('; ')}` : `\n✓ 校验通过`);

  return { json, nodeCount: nodes.length, tris: Math.round(indexCount / 3), animations, perMesh };
}

const target = process.argv[2];
if (!target) {
  console.error('用法: node tools/inspect_glb.mjs <file.glb>');
  process.exit(1);
}
summarize(target);
