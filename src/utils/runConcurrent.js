'use strict';

/**
 * Выполняет async fn для каждого элемента с ограничением числа одновременных задач (SMTP и т.п.).
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} fn
 */
async function runConcurrent(items, concurrency, fn) {
  if (!items || !items.length) return;
  const n = Math.max(1, Math.min(Number(concurrency) || 4, 32));
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i], i);
      } catch (e) {
        // fn сам обязан перехватывать; это страховка от необработанного reject
        console.error('[runConcurrent] unhandled:', e && e.message ? e.message : e);
      }
    }
  }
  const pool = Math.min(n, items.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
}

module.exports = { runConcurrent };
