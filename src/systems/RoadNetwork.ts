import * as THREE from 'three';
import type { AssetManifest } from '../assets/manifest';
import type { RoadGraph, GraphNode } from '../workers/pathfinding.worker';

/**
 * AGV 路网生成。
 *
 * 关键设计：路网不是手工标注的坐标列表，而是**从车间几何参数推导**出来的。
 * 这样改厂房尺寸、改产线布局，路网自动跟随，不会出现「AGV 撞墙」。
 *
 * 拓扑：
 *   主环线（沿产线两侧） + 4 条横向连接道 + 2 个充电/待命点
 * 全部节点落在 AGV 行驶带（Y=-4.5 / Y=4.5）与横向通道上，
 * 与地面标线一一对应，视觉上「路网就是画出来的那条路」。
 */
export interface RoadNetwork {
  graph: RoadGraph;
  /** nodeId → 世界坐标 */
  points: Map<number, THREE.Vector3>;
  /** 主环线节点顺序（用于绘制基准线） */
  loop: number[];
  /** 命名站点，供 UI 选择目的地 */
  stations: Array<{ id: string; name: string; nodeId: number }>;
}

const LANE_Y = -4.5;
const LANE_Y_NORTH = 4.5;

export function buildRoadGraph(manifest: AssetManifest): RoadNetwork {
  const { length: L, width: W } = manifest.hall;
  const zSouth = LANE_Y;
  const zNorth = Math.min(LANE_Y_NORTH, W * 0.34);

  const nodes: GraphNode[] = [];
  const points = new Map<number, THREE.Vector3>();
  const keyToId = new Map<string, number>();

  const add = (x: number, z: number, key: string): number => {
    const id = nodes.length;
    const node: GraphNode = { id, x, z, neighbors: [] };
    nodes.push(node);
    points.set(id, new THREE.Vector3(x, 0.06, z));
    keyToId.set(key, id);
    return id;
  };

  const link = (a: number, b: number): void => {
    if (a === b) return;
    const pa = points.get(a)!;
    const pb = points.get(b)!;
    const cost = pa.distanceTo(pb);
    nodes[a]!.neighbors.push({ id: b, cost });
    nodes[b]!.neighbors.push({ id: a, cost });
  };

  // ---------------- 主环线：南侧沿产线前后贯通
  const cols = [-L * 0.44, -L * 0.30, -L * 0.16, 0, L * 0.14, L * 0.28, L * 0.40];
  const southIds: number[] = [];
  const northIds: number[] = [];

  for (let i = 0; i < cols.length; i += 1) {
    const x = cols[i]!;
    southIds.push(add(x, zSouth, `S${i}`));
    northIds.push(add(x, zNorth, `N${i}`));
  }

  // 沿 X 方向串联
  for (let i = 0; i < cols.length - 1; i += 1) {
    link(southIds[i]!, southIds[i + 1]!);
    link(northIds[i]!, northIds[i + 1]!);
  }

  // ---------------- 横向连接道（东西两端 + 中间两条）
  const connectorIdx = [0, 2, 4, cols.length - 1];
  for (const i of connectorIdx) {
    link(southIds[i]!, northIds[i]!);
  }

  // ---------------- 充电位 / 待命区（延伸到南北两侧外侧）
  const chargeSouth = add(-L * 0.44, zSouth - 3.4, 'CHG_S');
  const chargeNorth = add(L * 0.40, zNorth + 3.2, 'CHG_N');
  link(chargeSouth, southIds[0]!);
  link(chargeNorth, northIds[northIds.length - 1]!);

  // 中控台前的待命点
  const standby = add(-L * 0.30, zNorth + 4.0, 'STANDBY');
  link(standby, northIds[1]!);

  // ---------------- 站名（供 UI 选目的地）
  const stations = [
    { id: 'dock_feed', name: '上料区', nodeId: southIds[1]! },
    { id: 'station_a', name: '装配工位 A', nodeId: southIds[3]! },
    { id: 'station_b', name: '包装出库', nodeId: southIds[5]! },
    { id: 'dock_west', name: '西侧月台', nodeId: southIds[0]! },
    { id: 'lane_north', name: '北侧通道', nodeId: northIds[3]! },
    { id: 'charge', name: '充电桩', nodeId: chargeSouth },
    { id: 'standby', name: '待命区', nodeId: standby },
  ];

  let totalLength = 0;
  for (const n of nodes) for (const e of n.neighbors) totalLength += e.cost;
  totalLength /= 2;

  const loop = [...southIds, ...northIds];

  console.info(
    `[RoadNetwork] ${nodes.length} 节点 / ${Math.round(totalLength)}m 路网 / ${stations.length} 个站点`,
  );

  return { graph: { nodes, totalLength }, points, loop, stations };
}

/** 找到离某个世界坐标最近的节点（用于「从 AGV 当前位置出发」） */
export function nearestNode(network: RoadNetwork, position: THREE.Vector3): number {
  let best = 0;
  let bestDist = Infinity;
  for (const [id, p] of network.points) {
    const d = (p.x - position.x) ** 2 + (p.z - position.z) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}

/** 把节点序列转成平滑曲线（CatmullRom），用于路径可视化与 AGV 行驶 */
export function pathToCurve(network: RoadNetwork, nodeIds: number[]): THREE.CatmullRomCurve3 {
  const pts = nodeIds
    .map((id) => network.points.get(id))
    .filter((p): p is THREE.Vector3 => p !== undefined);
  if (pts.length < 2) {
    return new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3()]);
  }
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.25);
}
