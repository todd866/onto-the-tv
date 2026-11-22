// A bounded, one-video-ahead screensaver. Preparing a preview never owns the TV.
export function createAmbientPlayer({ session, build, beforePlay = () => {}, onStatus = () => {} }) {
  let active = false, starting = false, closed = false, generation = 0;
  let controller, pending, options, startWork;
  const media = new Map();
  const cleaning = new Set();
  const status = (value, error) => onStatus({ status: value, ...(error ? { error } : {}) });

  function tidy(state = session.getState()) {
    const used = new Set([state.current?.path, ...state.upcoming.map(item => item.path)]);
    for (const [path, item] of media) if (!used.has(path) && path !== pending?.path) {
      media.delete(path);
      const work = Promise.resolve().then(() => item.cleanup()).finally(() => cleaning.delete(work));
      cleaning.add(work); work.catch(() => {});
    }
  }
  function cancel() {
    active = false; generation++; controller?.abort(); status('idle');
    // Retain the current file until the session has stopped serving it.
  }
  function prepareNext(state) {
    if (pending || !active || closed || state.upcoming.length || !media.has(state.current?.path)) return;
    const expected = state.current.path, version = generation;
    const signal = (controller = new AbortController()).signal;
    const job = {};
    pending = job;
    job.promise = (async () => {
      let item;
      try {
        item = await build(options, signal);
        if (!active || generation !== version || closed) { await item.cleanup(); return; }
        job.path = item.path; media.set(item.path, item);
        await session.queueNext({ path: item.path }, expected);
      } catch (error) {
        if (active && generation === version && !signal.aborted) {
          // Do not retry on each two-second TV poll or reclaim a stopped TV.
          active = false;
          status('error', `Screensaver will stop after this rotation: ${error.message}`);
        }
      } finally {
        if (pending === job) pending = null;
        tidy();
      }
    })();
  }
  const unsubscribe = session.onChange(state => {
    tidy(state);
    if (!active || starting) return;
    if (!media.has(state.current?.path)) { cancel(); return; }
    if (state.status === 'playing' || state.status === 'paused') prepareNext(state);
  });

  async function startCore(input) {
    if (closed) throw new Error('Screensaver is closed.');
    if (starting) throw new Error('Wait for the screensaver to finish preparing.');
    cancel();
    const version = generation;
    const previous = pending?.promise;
    if (previous) await previous;
    if (closed) throw new Error('Screensaver is closed.');
    if (version !== generation) return session.getState();
    starting = true;
    const signal = (controller = new AbortController()).signal;
    options = { ...input }; status('preparing');
    let item;
    try {
      item = await build(options, signal);
      if (version !== generation || closed) { await item.cleanup(); return session.getState(); }
      // Mark this file pending so a synchronous preparing-state notification
      // cannot remove it before playOnly has appended it to the session.
      pending = { path: item.path };
      media.set(item.path, item);
      beforePlay();
      if (version !== generation || closed) return session.getState();
      active = true;
      const state = await session.playOnly([{ path: item.path, startSeconds: 0 }]);
      if (version === generation && !closed) status('playing');
      return state;
    } catch (error) {
      active = false;
      if (!signal.aborted) { status('error', error.message); throw error; }
      return session.getState();
    } finally {
      starting = false; pending = null; tidy();
      if (active && version === generation) prepareNext(session.getState());
    }
  }
  async function close() {
    closed = true; cancel(); unsubscribe();
    await startWork;
    await pending?.promise;
    await Promise.allSettled([...media.values()].map(item => item.cleanup()));
    media.clear(); await Promise.allSettled([...cleaning]);
  }
  function start(input) {
    if (startWork) return Promise.reject(new Error('Wait for the screensaver to finish preparing.'));
    startWork = startCore(input).finally(() => { startWork = null; });
    return startWork;
  }
  return { start, cancel, close, getState: () => ({ active, starting, options: options && { ...options },
    pending: pending?.path || null, paths: [...media.keys()] }), owns: path => media.has(path) };
}
