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
    },
  };
}
