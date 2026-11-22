import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { answers, pickServer, serverList } from './server-pick.js';

describe('serverList', () => {
  it('prefers servers, keeps order, adds the trailing slash and drops junk and repeats', () => {
    assert.deepEqual(serverList({ server: 'http://127.0.0.1:8686/',
      servers: ['http://192.0.2.30:8686', 'http://127.0.0.1:8686/', 'ftp://x', 7, 'http://192.0.2.30:8686/'] }),
    ['http://192.0.2.30:8686/', 'http://127.0.0.1:8686/']);
  });
  it('falls back to the single server setting', () => {
    assert.deepEqual(serverList({ server: 'http://127.0.0.1:8686/' }), ['http://127.0.0.1:8686/']);
    assert.deepEqual(serverList({}), []);
  });
});

describe('pickServer', () => {
  it('skips a server that does not answer and takes the next healthy one', async () => {
    const seen = [];
    const fetch = async url => {
      seen.push(String(url));
      if (String(url).startsWith('http://192.0.2.30')) throw new Error('unreachable');
      return { ok: true };
    };
    const picked = await pickServer(['http://192.0.2.30:8686/', 'http://127.0.0.1:8686/'], { fetch });
    assert.equal(picked, 'http://127.0.0.1:8686/');
    assert.deepEqual(seen, ['http://192.0.2.30:8686/api/health', 'http://127.0.0.1:8686/api/health']);
  });
  it('returns null when nothing answers, and treats an error status as no answer', async () => {
    assert.equal(await pickServer(['http://192.0.2.1:8686/'], { fetch: async () => ({ ok: false }) }), null);
  });
  it('gives up on a server that hangs', async () => {
    const server = createServer(() => {});   // accepts, never replies
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      assert.equal(await answers(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 200 }), false);
      assert.ok(Date.now() - started < 2000);
    } finally { server.closeAllConnections(); server.close(); }
  });
});
