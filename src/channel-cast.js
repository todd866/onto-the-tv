import { castTarget } from './shuffler.js';

export function srcForPath(catalogue, path) {
  if (!catalogue || typeof path !== 'string' || !path) return '';
  for (const src of Object.keys(catalogue)) {
    if (catalogue[src] === path) return src;
  }
  return '';
}

export function playOnTv(session, catalogue, src, seconds) {
  const path = castTarget(catalogue, src);
  const start = Number(seconds);
  const startSeconds = Number.isFinite(start) && start > 0 ? Math.min(Math.round(start), 12 * 3600) : 0;
  return session.playOnly([{ path, startSeconds }]);
}

export async function queueOnTv(session, catalogue, src, currentSrc) {
  const path = castTarget(catalogue, src), currentPath = castTarget(catalogue, currentSrc);
  const state = await session.queueNext({ path, startSeconds: 0 }, currentPath);
  return state.current?.path === currentPath && state.upcoming.some(item => item.path === path);
}

export function tvNotice(catalogue, state) {
  if (!state || state.status === 'preparing') return null;
  if (state.status === 'finished') {
    return { type: 'onto:tv', tv: { path: '', positionSeconds: 0, durationSeconds: 0, status: 'finished' } };
  }
  if (state.status === 'idle' && !state.current) {
    return { type: 'onto:cast-off', reason: state.error || 'The TV stopped playing.' };
  }
  if (!state.current) return null;
  return {
    type: 'onto:tv',
    tv: {
      path: srcForPath(catalogue, state.current.path),
      positionSeconds: state.current.positionSeconds || 0,
      durationSeconds: state.current.durationSeconds || 0,
      status: state.status,
      ...(state.transition ? { transition: {
        ...state.transition,
        fromPath: srcForPath(catalogue, state.transition.fromPath),
        toPath: srcForPath(catalogue, state.transition.toPath),
      } } : {}),
    },
  };
}

// The TV session owns confirmed cast progress; iframe reports own local viewing.
// In particular, an optimistic cast seek must never overwrite a saved bookmark.
export async function recordLocalHistory(history, catalogue, input, { casting = false } = {}) {
  if (casting || !history || !input || typeof input.src !== 'string') return false;
  const path = castTarget(catalogue, input.src);
  const { positionSeconds, durationSeconds, completed } = input;
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0 ||
      !Number.isFinite(durationSeconds) || durationSeconds < 0 || typeof completed !== 'boolean') return false;
  history.set(path, { positionSeconds, durationSeconds, completed, reset: input.reset === true });
  await history.flush();
  return true;
}
