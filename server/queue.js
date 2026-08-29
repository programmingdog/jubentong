'use strict';

/**
 * 并发任务队列。
 *
 * 浏览器实例是稀缺资源：同时开太多上下文会吃满内存、并且更容易触发风控。
 * 所以所有解析任务都先排队，超出并发数的等待而不是一起挤进去。
 */

class TaskQueue {
  constructor({ concurrency = 2, timeoutMs = 90000 } = {}) {
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.running = 0;
    this.waiting = [];
    this.done = 0;
    this.failed = 0;
    this.totalWaitMs = 0;
  }

  get pending() {
    return this.waiting.length;
  }

  /**
   * 排队执行一个任务。
   * @param {() => Promise<any>} task
   * @returns {Promise<any>}
   */
  run(task) {
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, enqueuedAt: Date.now() };

      // 排队超时：避免调用方无限期挂起
      entry.timer = setTimeout(() => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) {
          this.waiting.splice(i, 1);
          reject(Object.assign(new Error('排队超时，服务器繁忙，请稍后重试'), { code: 'QUEUE_TIMEOUT' }));
        }
      }, this.timeoutMs);

      this.waiting.push(entry);
      this._pump();
    });
  }

  _pump() {
    while (this.running < this.concurrency && this.waiting.length) {
      const entry = this.waiting.shift();
      clearTimeout(entry.timer);
      this.running += 1;
      this.totalWaitMs += Date.now() - entry.enqueuedAt;

      Promise.resolve()
        .then(() => entry.task())
        .then(
          (v) => {
            this.done += 1;
            this.running -= 1;
            this._pump();
            entry.resolve(v);
          },
          (e) => {
            this.failed += 1;
            this.running -= 1;
            this._pump();
            entry.reject(e);
          }
        );
    }
  }

  stats() {
    return {
      concurrency: this.concurrency,
      running: this.running,
      pending: this.pending,
      done: this.done,
      failed: this.failed,
      avgWaitMs: this.done + this.failed > 0
        ? Math.round(this.totalWaitMs / (this.done + this.failed))
        : 0,
    };
  }
}

module.exports = { TaskQueue };
