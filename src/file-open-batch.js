// Finder delivers one open-file event per selection. Group the short burst so
// one multi-file selection replaces playback once, with the rest in its queue.
export function createFileOpenBatcher(open, {
  delayMs = 100,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onError = error => console.error(error),
} = {}) {
  const pending = new Set();
  let timer = null;

  function clearTimer() {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  }

  function flush() {
    clearTimer();
    if (!pending.size) return Promise.resolve();
    const paths = [...pending];
    pending.clear();
    // Turn synchronous callback failures into the same rejection as an async
    // open, and remove the batch before calling code that may enqueue another.
    return Promise.resolve().then(() => open(paths));
  }

  return {
    add(path) {
      pending.add(path);
      clearTimer();
      timer = setTimeoutImpl(() => { void flush().catch(onError); }, delayMs);
    },
    flush,
    cancel() { clearTimer(); pending.clear(); },
  };
}
