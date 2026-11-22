export function nextQueueAction({ queue, armedIndex, currentUri, state }) {
  const currentIndex = queue.findIndex((item) => item.url === currentUri);
  const stopped = state === 'STOPPED' || state === 'NO_MEDIA_PRESENT';

  if (currentIndex >= 0) {
    const following = currentIndex + 1;
    if (following < queue.length && armedIndex < following) {
      return { type: 'arm', index: following };
    }
    if (stopped && following < queue.length) {
      return { type: 'play', index: following };
    }
    return { type: 'wait' };
  }

  if (queue.length === 0) return { type: 'wait' };

  if (armedIndex < 0) {
    return stopped ? { type: 'play', index: 0 } : { type: 'arm', index: 0 };
  }

  if (stopped) return { type: 'play', index: armedIndex };
  return { type: 'wait' };
}
