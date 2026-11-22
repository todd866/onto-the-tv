// Press keys on a Samsung Smart TV over the home network, as its own remote does.
// 2016–2017 sets (Tizen 2.4–3) answer plain WebSocket on port 8001; the first
// connection makes the TV ask, on screen, whether to allow this device.

const DEFAULT_PORT = 8001;
const KEY_GAP_MS = 180;

export function remoteUrl(host, name = 'Onto the TV', port = DEFAULT_PORT) {
  const label = Buffer.from(name).toString('base64');
  return `ws://${host}:${port}/api/v2/channels/samsung.remote.control?name=${encodeURIComponent(label)}`;
}

export function keyMessage(key) {
  return JSON.stringify({ method: 'ms.remote.control',
    params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
}

/**
 * A remote that keeps one connection to the TV and presses keys in order.
 * `WebSocket` and `wait` are injectable for tests.
 */
export function createSamsungRemote({ host, name, port, WebSocket = globalThis.WebSocket,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {} } = {}) {
  if (!host) throw new Error('The TV’s address is not set.');
  let socket = null, ready = null, queue = Promise.resolve();

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(remoteUrl(host, name, port));
      let settled = false;
      const fail = message => {
        ready = null; socket = null;
        if (!settled) { settled = true; reject(new Error(message)); }
      };
      ws.onmessage = event => {
        let data = {};
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.event === 'ms.channel.connect' && !settled) { settled = true; socket = ws; resolve(ws); }
        else if (data.event === 'ms.channel.unauthorized') fail('The TV refused this Mac. Allow it on the TV, then try again.');
      };
      ws.onerror = () => fail('The TV is not answering on the network.');
      ws.onclose = () => fail('The TV closed the connection.');
    });
    return ready;
  }

  /** Press each key in turn, a short gap apart. Resolves when the last is sent. */
  function press(...keys) {
    const run = queue.then(async () => {
      const ws = await connect();
      for (let i = 0; i < keys.length; i++) {
        if (i) await wait(KEY_GAP_MS);
        ws.send(keyMessage(keys[i]));
        log(`tv key ${keys[i]}`);
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  function close() { try { socket?.close(); } catch {} socket = null; ready = null; }

  return { press, close };
}
