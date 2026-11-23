// A remote source for the playback cache (src/media-cache.js, option `remote`): reads one byte range of a video
// from an encrypted cloud backup of the library, so a title can play when its file is no longer on a drive.
// The idea (22 Nov 2026): keep enough of each title locally to start it, and backfill the rest from the cloud.
//
// The backup it reads is an rclone crypt remote with one object per file, laid out as
// `<prefix>/<source name>/<path under that source's folder>`. rclone can read part of such an object without
// fetching the rest (`rclone cat --offset --count`). Which remote, which keychain item holds its password, and
// which folders on this Mac are its sources are site values: they live in a config file in the server's data
// folder (see openCloudSource), never in this repository.
// Measured on 22 Nov 2026 on one 980 MB object: a read from the start, 25% in or 60% in began in 2.6-3.0 s from
// a cold rclone process and then ran at 30-95 Mbit/s, against a library whose median bitrate is 1 Mbit/s.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Run a program, optionally feeding it text on stdin; resolves with its stdout. Used for the two steps that
// touch the backup password, so neither the password nor its obscured form is ever an argument.
const runProgram = (program, args, input = null) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.on('error', error => reject(new Error(`cannot run ${program}: ${error.code || error.message}`)));
  child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${program} exited ${code}`))));
  child.stdin.end(input ?? '');
});

// Open the reader from a site config file, `cloud-source.json` in the server's data folder (never in this
// repository; nothing here names a real remote):
//   { "remote":    the rclone remote the crypt layer wraps,
//     "keychain":  the login keychain service that holds the backup's password,
//     "roots":     [{ "name": a source's name in the backup, "path": that source's folder on this Mac }, …],
//     "rootsFrom": optionally, a JSON file with a `sources` list of {name, path} to use instead of "roots",
//     "prefix":    the folder inside the backup that holds the sources (default "current") }
// The password goes from the keychain through `rclone obscure -` on stdin into the reader's child environment.
// Throws, without the password in the message, when the file or any part is missing; the server then simply
// runs without a cloud source.
export async function openCloudSource({ configPath, home = homedir(), run = runProgram, readJson = path => JSON.parse(readFileSync(path, 'utf8')),
  rclone = existsSync('/opt/homebrew/bin/rclone') ? '/opt/homebrew/bin/rclone' : 'rclone', env = process.env, timeoutMs,
  idFile = null } = {}) {
  if (!configPath) throw new Error('the cloud source needs its config file (cloud-source.json in the data folder)');
  const expand = path => String(path).replace(/^~(?=\/|$)/, home);
  let site;
  try { site = readJson(configPath); } catch { throw new Error(`the cloud source is not configured: ${configPath} is missing or unreadable`); }
  const { remote, keychain } = site || {};
  if (typeof remote !== 'string' || !remote.includes(':') || typeof keychain !== 'string' || !keychain) {
    throw new Error(`${configPath} must name the backup's "remote" and its "keychain" item`);
  }
  let listed = site.roots;
  if (!Array.isArray(listed) && typeof site.rootsFrom === 'string') {
    try { listed = readJson(expand(site.rootsFrom)).sources; } catch { listed = null; }
  }
  const roots = (Array.isArray(listed) ? listed : [])
    .filter(source => source && typeof source.name === 'string' && typeof source.path === 'string')
    .map(source => ({ name: source.name, path: expand(source.path) }));
  if (!roots.length) throw new Error(`${configPath} names no backup sources ("roots" or "rootsFrom")`);
  const prefix = typeof site.prefix === 'string' ? site.prefix.replace(/^\/+|\/+$/g, '') : 'current';
  const password = (await run('/usr/bin/security', ['find-generic-password', '-s', keychain, '-w'])).replace(/\n$/, '');
  if (!password) throw new Error('the backup password could not be read from the keychain (a logged-in or launchd session is needed, not ssh)');
  const obscured = (await run(rclone, ['obscure', '-'], password)).trim();
  if (!obscured) throw new Error('rclone obscure returned nothing');
  return createRcloneSource({ rclone, remote: `gcrypt:${prefix}`, roots, env: rcloneCryptEnv({ remote, obscuredPassword: obscured, base: env }),
    base: remote, idFile, serve: site.serve !== false, ...(timeoutMs ? { timeoutMs } : {}) });
}

// The environment for an rclone crypt remote named `gcrypt` (standard file-name and folder-name encryption). The password is
// the already-obscured one (`rclone obscure -`); it travels only in the child's environment, never in arguments,
// logs or errors. Reading it from the keychain is the caller's job and works only in a logged-in or launchd
// session, not over ssh.
export function rcloneCryptEnv({ remote, obscuredPassword, base = process.env }) {
  if (!remote || !obscuredPassword) throw new Error('rcloneCryptEnv needs the remote and the obscured password');
  return { ...base,
    RCLONE_CONFIG_GCRYPT_TYPE: 'crypt',
    RCLONE_CONFIG_GCRYPT_REMOTE: remote,
    RCLONE_CONFIG_GCRYPT_PASSWORD: obscuredPassword,
    RCLONE_CONFIG_GCRYPT_FILENAME_ENCRYPTION: 'standard',
    RCLONE_CONFIG_GCRYPT_DIRECTORY_NAME_ENCRYPTION: 'true' };
}

// roots: [{ path: a source's folder on this Mac, name: its name in the backup }, …].
// rclone: the program, or [program, ...leading arguments] (tests use that).
//
// base (the remote the crypt layer wraps) switches on reads by folder:
// a file's folder is looked up once and afterwards addressed by its Drive id, so rclone does not walk six
// encrypted folder levels for every block. Measured on a real backup, 22 Nov 2026, on a busy
// link: a 4 MiB block took 4.0-6.1 s by folder id against 11.6 s by path. The lookup is two steps: encrypt the
// folder's path locally (`cryptdecode --reverse`), then list its parent's folders on the plain remote and take
// the id of the one with that name (a stat of the folder itself returns no id). Ids are kept in memory and,
// with idFile, on disk: a folder's id does not change. If a read by id fails the id is forgotten and that
// block is read by path, as before.
export function createRcloneSource({ rclone = 'rclone', remote = 'gcrypt:current', roots, env = process.env, timeoutMs = 60000,
  base = null, idFile = null, serve = false }) {
  if (!Array.isArray(roots) || !roots.length) throw new Error('createRcloneSource needs the backed-up roots');
  const command = Array.isArray(rclone) ? rclone : [rclone];
  const sorted = roots.map(root => ({ prefix: root.path.replace(/\/+$/, '') + '/', name: root.name }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const relPath = file => {
    const root = sorted.find(candidate => file.startsWith(candidate.prefix));
    return root ? `${root.name}/${file.slice(root.prefix.length)}` : null;
  };
  const remotePath = file => {
    const rel = relPath(file);
    return rel ? `${remote}/${rel}` : null;
  };
  const fail = (message, code) => Object.assign(new Error(message), { code });
  // One rclone run; resolves with everything it wrote to stdout.
  const rcloneRun = (args, childEnv = env) => new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, complaint = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail(`cloud read timed out after ${timeoutMs} ms`, 'ETIMEDOUT')); }, timeoutMs);
    child.stdout.on('data', chunk => { chunks.push(chunk); size += chunk.length; });
    child.stderr.on('data', chunk => { complaint = (complaint + chunk).slice(-2000); });
    child.on('error', error => finish(fail(`cannot run rclone: ${error.message}`, 'EREMOTE')));
    child.on('close', code => {
      if (code !== 0) { finish(fail(`cloud read failed: ${complaint.trim().split('\n').pop() || `rclone exit ${code}`}`, 'EREMOTE')); return; }
      finish(null, Buffer.concat(chunks, size));
    });
  });
  const cat = (target, start, length, childEnv) => rcloneRun(['cat', target, '--offset', String(start), '--count', String(length),
    '--retries', '1', '--low-level-retries', '3'], childEnv);

  // ---- folders by id
  const cryptName = remote.slice(0, remote.indexOf(':'));                      // 'gcrypt'
  const insideCrypt = remote.slice(remote.indexOf(':') + 1).replace(/^\/+|\/+$/g, '');   // 'current'
  const ids = new Map();          // folder (as named through the crypt layer) -> id, or a promise of one
  if (idFile) {
    try { for (const [folder, id] of Object.entries(JSON.parse(readFileSync(idFile, 'utf8')))) if (typeof id === 'string' && id) ids.set(folder, id); }
    catch { /* no file yet, or unreadable: ids are looked up again */ }
  }
  const saveIds = () => {
    if (!idFile) return;
    try {
      const known = Object.fromEntries([...ids].filter(([, id]) => typeof id === 'string'));
      writeFileSync(`${idFile}.tmp`, JSON.stringify(known), { mode: 0o600 });
      renameSync(`${idFile}.tmp`, idFile);
    } catch { /* the ids are only a shortcut */ }
  };
  const lookUp = async folder => {            // folder: 'current/Stash/Movies/shelf/Show'
    const out = (await rcloneRun(['cryptdecode', '--reverse', `${cryptName}:`, folder])).toString().trim();
    const encrypted = out.slice(out.search(/\S+$/));              // "<plain path> <encrypted path>": the last word
    const cut = encrypted.lastIndexOf('/');
    if (!encrypted || cut < 0) throw fail('could not encrypt the folder path', 'EREMOTE');
    const listing = JSON.parse((await rcloneRun(['lsjson', `${base.replace(/\/+$/, '')}/${encrypted.slice(0, cut)}`, '--dirs-only',
      '--no-modtime', '--no-mimetype', '--retries', '1'])).toString());
    const hit = Array.isArray(listing) ? listing.find(item => item && item.Name === encrypted.slice(cut + 1)) : null;
    if (!hit || typeof hit.ID !== 'string' || !hit.ID) throw fail('the folder is not in the backup', 'ENOENT');
    return hit.ID;
  };
  const folderId = folder => {
    if (!ids.has(folder)) {
      const pending = lookUp(folder).then(id => { ids.set(folder, id); saveIds(); return id; },
        error => { if (ids.get(folder) === pending) ids.delete(folder); throw error; });
      ids.set(folder, pending);
    }
    return Promise.resolve(ids.get(folder));
  };
  const byIdEnv = id => ({ ...env,
    RCLONE_CONFIG_GCRYPTDIR_TYPE: 'crypt',
    RCLONE_CONFIG_GCRYPTDIR_REMOTE: `${base.slice(0, base.indexOf(':'))},root_folder_id=${id}:`,
    RCLONE_CONFIG_GCRYPTDIR_PASSWORD: env[`RCLONE_CONFIG_${cryptName.toUpperCase()}_PASSWORD`],
    RCLONE_CONFIG_GCRYPTDIR_FILENAME_ENCRYPTION: 'standard',
    RCLONE_CONFIG_GCRYPTDIR_DIRECTORY_NAME_ENCRYPTION: 'true' });

  // ---- persistent loopback HTTP server (`rclone serve http`, enabled by `serve: true`)
  let serverState = null; // Promise<{ port, authHeader, child }> | null
  let closed = false;
  const pickFreePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(err => (err ? reject(err) : resolve(port)));
    });
  });
  const httpRequest = ({ port, path, method = 'GET', headers = {}, timeout = timeoutMs }) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []; let total = 0;
      res.on('data', chunk => { chunks.push(chunk); total += chunk.length; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks, total) }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(fail(`cloud read timed out after ${timeout} ms`, 'ETIMEDOUT')));
    req.on('error', reject);
    req.end();
  });
  const startServer = async () => {
    const port = await pickFreePort();
    const user = 'onto';
    const pass = randomBytes(24).toString('hex');
    const authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    const childEnv = { ...env, RCLONE_USER: user, RCLONE_PASS: pass };
    const args = [...command.slice(1), 'serve', 'http', remote,
      '--addr', `127.0.0.1:${port}`,
      '--read-only',
      '--disable-zip',
      '--dir-cache-time', '24h',
      '--vfs-read-chunk-size', '4M',
      '--vfs-read-chunk-size-limit', '32M'];
    const child = spawn(command[0], args, { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    child.unref();
    let stderrTail = '', exited = false, exitCode = null;
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-2000); });
    child.on('close', code => {
      exited = true; exitCode = code;
      if (serverState) serverState.then(s => { if (s.child === child) serverState = null; }).catch(() => {});
    });
    child.on('error', () => { exited = true; });
    const deadline = Date.now() + Math.min(timeoutMs, 8000);
    while (Date.now() < deadline) {
      if (exited || closed) {
        try { child.kill('SIGTERM'); } catch {}
        throw fail(`rclone serve http exited (${exitCode ?? 'err'}): ${stderrTail.trim().split('\n').pop() || 'failed'}`, 'EREMOTE');
      }
      try {
        const probe = await httpRequest({ port, path: '/', method: 'HEAD', headers: { Authorization: authHeader }, timeout: 1000 });
        if (probe.status === 200 || probe.status === 404) return { port, authHeader, child };
      } catch { /* still starting */ }
      await new Promise(r => setTimeout(r, 40));
    }
    try { child.kill('SIGKILL'); } catch {}
    throw fail('rclone serve http did not become ready in time', 'ETIMEDOUT');
  };
  const ensureServer = () => {
    if (closed) throw fail('cloud source is closed', 'EREMOTE');
    if (!serverState) {
      const pending = startServer().catch(err => {
        if (serverState === pending) serverState = null;
        throw err;
      });
      serverState = pending;
    }
    return serverState;
  };
  const httpRead = async (rel, start, length) => {
    if (length <= 0) return Buffer.alloc(0);
    const { port, authHeader, child } = await ensureServer();
    const encodedPath = '/' + rel.split('/').map(encodeURIComponent).join('/');
    let res;
    try {
      res = await httpRequest({
        port,
        path: encodedPath,
        headers: { Authorization: authHeader, Range: `bytes=${start}-${start + length - 1}` },
        timeout: timeoutMs,
      });
    } catch (err) {
      if (err.code === 'ETIMEDOUT') throw err;
      try { child.kill('SIGTERM'); } catch {}
      serverState = null;
      throw fail(`cloud http read failed: ${err.message}`, 'EREMOTE');
    }
    if (res.status === 404) throw fail('object not found', 'ENOENT');
    if (res.status === 416) return Buffer.alloc(0);
    if (res.status !== 206 && res.status !== 200) throw fail(`cloud http status ${res.status}`, 'EREMOTE');
    return res.status === 200 ? res.body.subarray(start, start + length) : res.body.subarray(0, length);
  };

  const read = async (file, start, length) => {
    const rel = relPath(file);
    if (!rel) throw fail('this file is not under a backed-up folder', 'ENOENT');
    const target = `${remote}/${rel}`;
    if (serve) {
      try {
        return await httpRead(rel, start, length);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ETIMEDOUT') throw error;
        // Daemon unavailable or unexpected HTTP error: fall back cleanly to single-block rclone cat.
      }
    }
    if (base) {
      const rest = target.slice(remote.length + 1), cut = rest.lastIndexOf('/');
      const folder = `${insideCrypt}${insideCrypt && cut >= 0 ? '/' : ''}${cut >= 0 ? rest.slice(0, cut) : ''}`;
      try {
        const id = await folderId(folder);
        return await cat(`gcryptdir:${rest.slice(cut + 1)}`, start, length, byIdEnv(id));
      } catch (error) {
        if (error.code === 'ETIMEDOUT') throw error;
        ids.delete(folder);                       // a stale id, or a folder not found: this block goes by path
      }
    }
    return cat(target, start, length, env);
  };
  read.remotePath = remotePath;
  read.knownFolders = () => [...ids].filter(([, id]) => typeof id === 'string').length;
  read.close = async () => {
    closed = true;
    const active = serverState;
    serverState = null;
    if (!active) return;
    try {
      const { child } = await active;
      if (child.exitCode === null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 1500);
          timer.unref?.();
          child.once('close', () => { clearTimeout(timer); resolve(); });
          try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
        });
      }
    } catch { /* never started */ }
  };
  return read;
}
