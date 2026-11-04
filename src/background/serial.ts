/** One at a time: each task chains on the queue's last so tasks run in the order asked, and a failed one doesn't break the chain. */
export function serialQueue() {
  let queue: Promise<unknown> = Promise.resolve()
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }
}
