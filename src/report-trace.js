// IPC payloads may contain viewing profiles or file contents. Record shape, not objects.
export function shortArgs(args) {
  return args.slice(0, 5).map(value => {
    if (typeof value === 'string') return value.slice(0, 160);
    if (Array.isArray(value)) return { array: value.length };
    if (value && typeof value === 'object') return { keys: Object.keys(value).slice(0, 12) };
    return value;
  });
}

export function createStateTrace(record) {
  let previous = {};
  return state => {
    const current = { path: state.current?.path || null, status: state.status,
      position: Math.floor((state.current?.positionSeconds || 0) / 5) * 5,
      error: state.error || null };
    const diff = Object.fromEntries(Object.entries(current).filter(([key, value]) => previous[key] !== value));
    if (Object.keys(diff).length) record('state', diff);
    previous = current;
  };
}

export function traceRenderer(renderer, trace) {
  const invoke = renderer.invoke.bind(renderer);
  renderer.invoke = async (action, fields, options) => {
    trace('upnp:request', { action, fields: Object.fromEntries(Object.entries(fields)
      .filter(([key]) => !key.endsWith('MetaData'))) });
    try {
      const result = await invoke(action, fields, options);
      trace('upnp:response', { action, response: result.slice(0, 2000) });
      return result;
    } catch (error) { trace('upnp:error', { action, error: error.message }); throw error; }
  };
  return renderer;
}
