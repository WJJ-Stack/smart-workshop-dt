/**
 * A* 路径规划 Worker。
 *
 * 为什么必须放 Worker：
 * A* 在 200×200 网格上的最坏情况能跑到 100ms+，放主线程会直接掉帧。
 * 这个场景虽然路网较小（约 40×30 节点），但演示「大模型优化」时
 * 主线程零阻塞是可量化的卖点，所以统一走 Worker。
 *
 * 与主线程的协议：
 *   → { type: 'init', graph }
 *   → { type: 'plan', id, from, to }
 *   ← { type: 'ready' }
 *   ← { type: 'result', id, path, distance, expanded }
 *   ← { type: 'error', id, message }
 */
/// <reference lib="webworker" />

export interface GraphNode {
  id: number;
  x: number;
  z: number;
  /** 相邻节点 id 与代价（米） */
  neighbors: Array<{ id: number; cost: number }>;
}

export interface RoadGraph {
  nodes: GraphNode[];
  /** 路网总长度，用于统计 */
  totalLength: number;
}

export interface PlanRequest {
  type: 'plan';
  id: number;
  from: number;
  to: number;
}

export interface InitRequest {
  type: 'init';
  graph: RoadGraph;
}

export type WorkerRequest = InitRequest | PlanRequest;

export interface PlanResult {
  type: 'result';
  id: number;
  path: number[];
  distance: number;
  expanded: number;
  ms: number;
}

export interface WorkerError {
  type: 'error';
  id: number;
  message: string;
}

export interface ReadyMessage {
  type: 'ready';
  nodeCount: number;
}

export type WorkerResponse = PlanResult | WorkerError | ReadyMessage;

let graph: RoadGraph | null = null;

/** 极简二叉堆：A* 的 open set 用堆比数组快一个数量级 */
class MinHeap {
  private readonly items: Array<{ node: number; f: number }> = [];

  push(node: number, f: number): void {
    this.items.push({ node, f });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]!.f <= this.items[i]!.f) break;
      [this.items[parent], this.items[i]] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.items[l]!.f < this.items[smallest]!.f) smallest = l;
        if (r < this.items.length && this.items[r]!.f < this.items[smallest]!.f) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i]!, this.items[smallest]!];
        i = smallest;
      }
    }
    return top.node;
  }

  get size(): number {
    return this.items.length;
  }
}

function heuristic(a: GraphNode, b: GraphNode): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function plan(from: number, to: number): { path: number[]; distance: number; expanded: number } {
  if (!graph) throw new Error('路网未初始化');
  const nodes = graph.nodes;
  const start = nodes[from];
  const goal = nodes[to];
  if (!start || !goal) throw new Error(`节点不存在: ${from} → ${to}`);

  const gScore = new Float64Array(nodes.length).fill(Infinity);
  const cameFrom = new Int32Array(nodes.length).fill(-1);
  const closed = new Uint8Array(nodes.length);

  gScore[from] = 0;
  const open = new MinHeap();
  open.push(from, heuristic(start, goal));

  let expanded = 0;

  while (open.size > 0) {
    const current = open.pop()!;
    if (closed[current]) continue;
    if (current === to) break;

    closed[current] = 1;
    expanded += 1;

    const node = nodes[current]!;
    for (const edge of node.neighbors) {
      if (closed[edge.id]) continue;
      const tentative = gScore[current]! + edge.cost;
      if (tentative >= gScore[edge.id]!) continue;

      gScore[edge.id] = tentative;
      cameFrom[edge.id] = current;
      const n = nodes[edge.id]!;
      open.push(edge.id, tentative + heuristic(n, goal));
    }
  }

  if (cameFrom[to] === -1 && from !== to) {
    throw new Error('路网不连通，无法规划路径');
  }

  const path: number[] = [];
  let cur = to;
  let guard = 0;
  while (cur !== -1 && guard < nodes.length + 1) {
    path.push(cur);
    if (cur === from) break;
    cur = cameFrom[cur]!;
    guard += 1;
  }
  path.reverse();

  return { path, distance: gScore[to]!, expanded };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    graph = msg.graph;
    const ready: ReadyMessage = { type: 'ready', nodeCount: msg.graph.nodes.length };
    self.postMessage(ready);
    return;
  }

  if (msg.type === 'plan') {
    const t0 = performance.now();
    try {
      const { path, distance, expanded } = plan(msg.from, msg.to);
      const result: PlanResult = {
        type: 'result',
        id: msg.id,
        path,
        distance,
        expanded,
        ms: performance.now() - t0,
      };
      self.postMessage(result);
    } catch (err) {
      const error: WorkerError = {
        type: 'error',
        id: msg.id,
        message: (err as Error).message,
      };
      self.postMessage(error);
    }
  }
};
