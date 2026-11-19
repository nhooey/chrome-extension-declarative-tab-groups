// One queue per key, such as a group's title: a task starts once every
// task queued before it under the same key has settled, and tasks under
// different keys run side by side. Each key's last task and its count of
// unsettled tasks are the only state; a key leaves it when its queue
// empties.

/** How many tasks may wait behind the running one under a key. */
export const MAX_WAITING = 100;

/**
 * Runs a task after the tasks queued before it under its key and settles
 * as the task does; when `MAX_WAITING` tasks already wait under the key,
 * resolves to `overflow()` instead, without running the task.
 */
export type Enqueue = <T>(
  key: string,
  task: () => Promise<T>,
  overflow: () => T,
) => Promise<T>;

type Queue = { readonly tail: Promise<void>; readonly unsettled: number };

export const queueByKey = (maxWaiting: number = MAX_WAITING): Enqueue => {
  const queues = new Map<string, Queue>();
  return <T>(
    key: string,
    task: () => Promise<T>,
    overflow: () => T,
  ): Promise<T> => {
    const queue = queues.get(key) ?? { tail: Promise.resolve(), unsettled: 0 };
    // One unsettled task runs; the rest wait.
    if (queue.unsettled - 1 >= maxWaiting) {
      return Promise.resolve(overflow());
    }
    const result = queue.tail.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, { tail, unsettled: queue.unsettled + 1 });
    void tail.then(() => {
      const current = queues.get(key);
      if (current !== undefined) {
        if (current.unsettled <= 1) {
          queues.delete(key);
        } else {
          queues.set(key, { ...current, unsettled: current.unsettled - 1 });
        }
      }
    });
    return result;
  };
};
