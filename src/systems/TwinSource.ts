import type { TwinMetric, TwinStatus } from '../shared/events';

/**
 * 孪生数据源（模拟）。
 *
 * 设计成「可替换的接口」而不是直接写死 Math.random()：
 *   1. 真实项目里数据来自 MQTT / WebSocket / OPC-UA，前端不应感知差异；
 *   2. 接口隔离后，把 MockTwinSource 换成 WsTwinSource 只需改一行；
 *   3. 模拟器本身要足够"像真的"：有状态机、有惯性、有偶发故障，
 *      否则演示时数据会跳变得很假。
 *
 * 关键工程点：数据推送是高频的（10Hz+），但 UI 与材质更新应当合并到帧循环。
 * 这里用「快照 + 脏标记」模式：源只管写状态，消费者每帧读一次增量。
 */
export interface TwinSnapshot {
  entityId: string;
  status: TwinStatus;
  metrics: TwinMetric[];
  /** 0..1 综合负荷，用于热力着色 */
  load: number;
  /** 本次更新是否触发了状态变化 */
  statusChanged: boolean;
}

export type TwinListener = (snapshots: TwinSnapshot[]) => void;

export interface TwinSource {
  start(): void;
  stop(): void;
  get(entityId: string): TwinSnapshot | undefined;
  all(): TwinSnapshot[];
  /** 订阅变更（每 tick 一次，批量回调，避免高频抖动） */
  subscribe(listener: TwinListener): () => void;
  /** 手动注入故障，用于演示 */
  injectFault(entityId: string): void;
  clearFault(entityId: string): void;
}

interface DeviceModel {
  entityId: string;
  kind: string;
  status: TwinStatus;
  /** 目标状态与当前状态分离，用一阶惯性逼近，避免状态跳变 */
  targetStatus: TwinStatus;
  cycleTime: number;
  throughput: number;
  goodRate: number;
  load: number;
  temp: number;
  /** 剩余状态持续时间（秒） */
  holdFor: number;
  faultCooldown: number;
}

const TICK_HZ = 8;

export class MockTwinSource implements TwinSource {
  private readonly devices = new Map<string, DeviceModel>();
  private readonly listeners = new Set<TwinListener>();
  private timer: number | null = null;
  private lastTick = 0;
  private readonly snapshots = new Map<string, TwinSnapshot>();

  private readonly rngInstance: () => number;

  constructor(
    devices: Array<{ id: string; kind: string }>,
    seed = 20261029,
  ) {
    // 必须在使用前初始化：构造函数里会调用 rng() 生成初始冷却时间
    this.rngInstance = mulberry32(seed);

    for (const d of devices) {
      this.devices.set(d.id, {
        entityId: d.id,
        kind: d.kind,
        status: 'running',
        targetStatus: 'running',
        cycleTime: baseCycleTime(d.kind),
        throughput: 0,
        goodRate: 0.985,
        load: 0.55,
        temp: 42,
        holdFor: 0,
        faultCooldown: 20 + this.rng() * 40,
      });
    }
  }

  private rng(): number {
    return this.rngInstance();
  }

  start(): void {
    if (this.timer !== null) return;
    this.lastTick = performance.now();
    // 用 setInterval 而不是 rAF：数据源不应与渲染帧率耦合，
    // 真实的 MQTT 推送也不会跟着屏幕刷新走。
    this.timer = window.setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get(entityId: string): TwinSnapshot | undefined {
    return this.snapshots.get(entityId);
  }

  all(): TwinSnapshot[] {
    return [...this.snapshots.values()];
  }

  subscribe(listener: TwinListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  injectFault(entityId: string): void {
    const d = this.devices.get(entityId);
    if (!d) return;
    d.targetStatus = 'fault';
    d.holdFor = 12;
    d.faultCooldown = 60;
  }

  clearFault(entityId: string): void {
    const d = this.devices.get(entityId);
    if (!d) return;
    d.targetStatus = 'running';
    d.holdFor = 0;
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;

    const batch: TwinSnapshot[] = [];

    for (const d of this.devices.values()) {
      this.step(d, dt);
      const snap = this.buildSnapshot(d);
      const prev = this.snapshots.get(d.entityId);
      snap.statusChanged = prev ? prev.status !== snap.status : true;
      this.snapshots.set(d.entityId, snap);
      batch.push(snap);
    }

    for (const fn of this.listeners) fn(batch);
  }

  /**
   * 单个设备的演化逻辑。
   *
   * 刻意实现成「状态机 + 惯性」而不是每次随机重采样：
   * - 状态机：running → (偶发) idle / fault / maintenance，有停留时长；
   * - 惯性：cycleTime / load / temp 都朝目标值平滑逼近，
   *   所以曲线是连续变化的，不会像 random 那样锯齿跳变。
   */
  private step(d: DeviceModel, dt: number): void {
    d.holdFor -= dt;
    d.faultCooldown -= dt;

    // --- 状态机转移
    if (d.holdFor <= 0) {
      if (d.targetStatus === 'fault') {
        d.targetStatus = 'maintenance';
        d.holdFor = 6 + this.rng() * 4;
      } else if (d.targetStatus === 'maintenance') {
        d.targetStatus = 'running';
        d.holdFor = 20 + this.rng() * 30;
        d.faultCooldown = 45 + this.rng() * 60;
      } else if (d.targetStatus === 'idle') {
        d.targetStatus = 'running';
        d.holdFor = 15 + this.rng() * 25;
      } else {
        // running 时随机进入 idle 或（冷却结束后）故障
        const roll = this.rng();
        if (d.faultCooldown <= 0 && roll < 0.045) {
          d.targetStatus = 'fault';
          d.holdFor = 8 + this.rng() * 6;
          d.faultCooldown = 999;
        } else if (roll < 0.09) {
          d.targetStatus = 'idle';
          d.holdFor = 4 + this.rng() * 6;
        } else {
          d.holdFor = 12 + this.rng() * 24;
        }
      }
    }

    d.status = d.targetStatus;

    // --- 指标演化（一阶惯性）
    const running = d.status === 'running';
    const baseCycle = baseCycleTime(d.kind);
    const targetCycle = running ? baseCycle * (0.92 + this.rng() * 0.16) : baseCycle * 1.35;
    const targetLoad = running ? 0.55 + this.rng() * 0.3 : 0.12;
    const targetTemp = running ? 48 + this.rng() * 8 : 34;

    d.cycleTime = approach(d.cycleTime, targetCycle, 1.6, dt);
    d.load = approach(d.load, targetLoad, 2.4, dt);
    d.temp = approach(d.temp, targetTemp, 0.7, dt);
    d.goodRate = clamp(approach(d.goodRate, running ? 0.985 : 0.94, 0.5, dt), 0.9, 0.999);

    if (running) {
      d.throughput += dt * (3600 / Math.max(1, d.cycleTime)) * 0.016;
    }
  }

  private buildSnapshot(d: DeviceModel): TwinSnapshot {
    return {
      entityId: d.entityId,
      status: d.status,
      load: d.load,
      statusChanged: false,
      metrics: [
        { label: '节拍', value: `${d.cycleTime.toFixed(1)} s`, tone: d.cycleTime > 40 ? 'warn' : undefined },
        {
          label: d.kind === 'conveyor' ? '线速' : d.kind === 'agv' ? '电量' : '产能',
          value:
            d.kind === 'conveyor'
              ? `${(0.3 + d.load * 0.3).toFixed(2)} m/s`
              : d.kind === 'agv'
                ? `${Math.round(60 + d.load * 35)}%`
                : `${Math.round(d.throughput * 10) / 10}`,
          tone: d.load > 0.85 ? 'warn' : 'ok',
        },
        {
          label: '良率',
          value: `${(d.goodRate * 100).toFixed(1)}%`,
          tone: d.goodRate < 0.96 ? 'warn' : 'ok',
        },
        {
          label: '温度',
          value: `${d.temp.toFixed(0)}°C`,
          tone: d.temp > 54 ? 'bad' : d.temp > 50 ? 'warn' : undefined,
        },
      ],
    };
  }
}

function baseCycleTime(kind: string): number {
  switch (kind) {
    case 'robot':
      return 28;
    case 'inspection':
      return 16;
    case 'packer':
      return 18;
    case 'agv':
      return 42;
    case 'conveyor':
      return 8;
    default:
      return 22;
  }
}

/** 一阶惯性逼近：与帧率无关，lambda 越大越快 */
function approach(current: number, target: number, lambda: number, dt: number): number {
  const t = 1 - Math.exp(-lambda * dt);
  return current + (target - current) * t;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 可复现的伪随机（mulberry32）：演示时每次刷新表现一致，便于截图/录屏 */
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
