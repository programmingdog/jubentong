'use strict';

/**
 * 带 TTL 与容量上限的内存缓存。
 * 用于缓存解析结果——同一链接短时间内重复请求时直接返回，省掉浏览器开销。
 */

class TtlCache {
  constructor({ ttlMs = 1800000, max = 500, name = 'cache' } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.name = name;
    this.map = new Map(); // key -> { value, expireAt, createdAt }
    this.hits = 0;
    this.misses = 0;

    // 定期清扫过期项，避免只增不减
    this.timer = setInterval(() => this.sweep(), Math.min(ttlMs, 60000));
    if (this.timer.unref) this.timer.unref();
  }

  get(key) {
    const item = this.map.get(key);
    if (!item) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() > item.expireAt) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // 命中后重新插到末尾，维持 LRU 顺序
    this.map.delete(key);
    this.map.set(key, item);
    this.hits += 1;
    return item.value;
  }

  /** 返回缓存项的剩余有效毫秒数，未命中返回 0 */
  ttl(key) {
    const item = this.map.get(key);
    if (!item) return 0;
    const left = item.expireAt - Date.now();
    return left > 0 ? left : 0;
  }

  set(key, value, ttlMs) {
    // 容量满了先淘汰最旧的
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, {
      value,
      createdAt: Date.now(),
      expireAt: Date.now() + (ttlMs || this.ttlMs),
    });
    return value;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.map) {
      if (now > v.expireAt) {
        this.map.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  stats() {
    return {
      name: this.name,
      size: this.map.size,
      max: this.max,
      hits: this.hits,
      misses: this.misses,
      ttlMs: this.ttlMs,
    };
  }

  destroy() {
    clearInterval(this.timer);
    this.map.clear();
  }
}

module.exports = { TtlCache };
