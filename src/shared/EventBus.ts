/**
 * 类型安全的事件总线。
 *
 * 为什么不用 mitt / eventemitter3：
 * 1. 需要编译期保证事件名与 payload 类型一致（mitt 也能做，但要额外声明合并）；
 * 2. 需要「一次性监听」与「作用域销毁」，孪生场景里实体频繁增删，泄漏很痛。
 */
export type EventMap = Record<string, unknown>;

export type Handler<T> = (payload: T) => void;
export type Unsubscribe = () => void;

interface Entry<T> {
  handler: Handler<T>;
  once: boolean;
  /** 派发中删除时延后处理，避免遍历数组时跳过元素 */
  disposed: boolean;
}

export class EventBus<E extends EventMap> {
  private readonly map = new Map<keyof E, Set<Entry<E[keyof E]>>>();
  private dispatchDepth = 0;

  on<K extends keyof E>(type: K, handler: Handler<E[K]>): Unsubscribe {
    return this.add(type, handler as Handler<E[keyof E]>, false);
  }

  once<K extends keyof E>(type: K, handler: Handler<E[K]>): Unsubscribe {
    return this.add(type, handler as Handler<E[keyof E]>, true);
  }

  off<K extends keyof E>(type: K, handler: Handler<E[K]>): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const entry of set) {
      if (entry.handler === handler) entry.disposed = true;
    }
    this.compact(type);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    this.dispatchDepth += 1;
    try {
      for (const entry of set) {
        if (entry.disposed) continue;
        if (entry.once) entry.disposed = true;
        try {
          entry.handler(payload);
        } catch (err) {
          console.error(`[EventBus] handler for "${String(type)}" threw`, err);
        }
      }
    } finally {
      this.dispatchDepth -= 1;
      if (this.dispatchDepth === 0) this.compact(type);
    }
  }

  clear(type?: keyof E): void {
    if (type === undefined) {
      this.map.clear();
      return;
    }
    this.map.delete(type);
  }

  listenerCount(type: keyof E): number {
    return this.map.get(type)?.size ?? 0;
  }

  private add(type: keyof E, handler: Handler<E[keyof E]>, once: boolean): Unsubscribe {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    const entry: Entry<E[keyof E]> = { handler, once, disposed: false };
    set.add(entry);
    return () => {
      entry.disposed = true;
      if (this.dispatchDepth === 0) this.compact(type);
    };
  }

  private compact(type: keyof E): void {
    if (this.dispatchDepth > 0) return;
    const set = this.map.get(type);
    if (!set) return;
    for (const entry of set) {
      if (entry.disposed) set.delete(entry);
    }
    if (set.size === 0) this.map.delete(type);
  }
}
