// Start every read before waiting for the iframe. The note is a later, separate write.
export function createReportCapture({ snapshot, renderer, capturePage, write, timeoutMs = 1500 }) {
  return async function capture(source, input = {}) {
    const at = input.at || new Date().toISOString();
    const frozen = structuredClone(snapshot());
    const settings = input.storedSettings;
    let image;
    try { image = Promise.resolve(capturePage()).catch(error => ({ error: error.message })); }
    catch (error) { image = Promise.resolve({ error: error.message }); }
    let timer;
    const state = structuredClone(await Promise.race([
      Promise.resolve().then(() => renderer(input)).catch(error => ({ channel: { unavailable: true, error: error.message } })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ channel: { unavailable: true } }), timeoutMs); }),
    ]).finally(() => clearTimeout(timer)));
    const screenshot = await image;
    return write({ ...frozen, ...state, mode: input.mode || frozen.mode || state.mode, ...(settings ? { settings: await settings } : {}), at, source, note: '' }, screenshot);
  };
}
