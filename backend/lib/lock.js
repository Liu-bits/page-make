// 进程内按 key 串行化（简易互斥锁）
//
// 用途：把「读记录 → 校验配额/状态 → 写回」这一段包成临界区。
// 不加锁时两个并发请求会读到同一份旧快照、都通过校验，然后各自写回，
// 形成典型的 TOCTOU（配额可被并发绕过、列表可回退）。
//
// 适用范围：本后端是单进程 Node 服务（docker/server.mjs），进程内锁即可覆盖
// 全部请求；多进程部署需要换成外部锁（KV 无原子 CAS，当前不做）。
//
// 实现要点：
// - 用 Promise 链排队，绝不 reject（避免一个失败把后续全部拖垮）
// - 队列走完立刻从 Map 删除，不会无限增长

const chains = new Map();

/**
 * 以 key 为粒度串行执行 task。
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withLock(key, task) {
  const prev = chains.get(key) || Promise.resolve();
  // 先给个初始值：静态检查脚本要求「被调用的标识符」有可见的声明
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  chains.set(key, tail);

  return (async () => {
    await prev;
    try {
      return await task();
    } finally {
      release();
      if (chains.get(key) === tail) chains.delete(key);
    }
  })();
}
