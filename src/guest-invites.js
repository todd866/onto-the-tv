// Guest invites for the phone web app (stage 1 of the invite site: friends and family).
// An invite is a link with a secret; opening it starts a session cookie for that guest.
// Only SHA-256 hashes of invite and session secrets are stored, so the file on disk
// cannot be replayed. Each guest has a rating ceiling and an expiry, and can be revoked.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, rename, stat, writeFile } from 'node:fs/promises';

export const GUEST_RATINGS = ['G', 'PG', 'M'];
const DAY_MS = 86_400_000;
const MAX_SESSIONS = 8;

const hash = secret => createHash('sha256').update(String(secret)).digest('hex');
const secret = () => randomBytes(24).toString('base64url');
const idFor = name => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Guests file: { guests: [{ id, name, rating, created, expires, revoked, invite, sessions: [{ hash, created, seen }] }] } */
export async function createGuestInvites(path, { now = () => Date.now() } = {}) {
  let data = { guests: [] }, stamp = '';
  // The invite command and the running server share this file: reread it when it changes.
  // Only ever called inside the queue below, so a slow read cannot land over a newer commit.
  async function reload(force = false) {
    const info = await stat(path).catch(() => null);
    const now = info ? `${info.mtimeMs}:${info.size}` : '';
    if (!force && now === stamp) return;
    try {
      const parsed = info ? JSON.parse(await readFile(path, 'utf8')) : { guests: [] };
      data = Array.isArray(parsed?.guests) ? parsed : { guests: [] };
      stamp = now;
    } catch (error) { throw new Error(`Cannot read guests: ${error.message}`); }
  }
  await reload();

  // Every read and every change runs one at a time in this queue. Changes are one
  // read-modify-replace under a kernel lock (macOS O_EXLOCK) shared with the invite
  // command; the kernel releases it if a holder dies, so no lock is ever stolen or deleted.
  const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | 0x20 /* O_EXLOCK */ | 0x4 /* O_NONBLOCK */;
  const lock = `${path}.lock`;
  async function acquire() {
    for (let tries = 0; ; tries++) {
      try { return await open(lock, LOCK_FLAGS, 0o600); }
      catch (error) {
        if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error;
        if (tries > 400) throw new Error('Guests file is busy.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
  let queue = Promise.resolve();
  function serial(task) {
    const run = queue.catch(() => {}).then(task);
    queue = run;
    return run;
  }
  const refresh = () => serial(() => reload());
  function transaction(change) {
    return serial(async () => {
      const handle = await acquire();
      try {
        await reload(true);
        const result = await change();
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, path);
        const info = await stat(path);
        stamp = `${info.mtimeMs}:${info.size}`;
        return result;
      } finally { await handle.close().catch(() => {}); }
    });
  }

  const live = guest => guest && !guest.revoked && guest.expires > now();
  const find = name => data.guests.find(guest => guest.id === idFor(name));
  const view = guest => ({ id: guest.id, name: guest.name, rating: guest.rating, expires: guest.expires,
    revoked: !!guest.revoked, sessions: guest.sessions.length });

  return {
    /** New or renewed invite. Returns the raw invite secret, shown once. */
    async invite(name, { rating = 'M', days = 7 } = {}) {
      const id = idFor(name);
      if (!id) throw new Error('A guest needs a name.');
      if (!GUEST_RATINGS.includes(rating)) throw new Error(`Rating must be one of ${GUEST_RATINGS.join(', ')}.`);
      if (!(days > 0 && days <= 90)) throw new Error('Days must be between 1 and 90.');
      const code = secret();
      return transaction(() => {
        const existing = find(name);
        const guest = existing || { id, name: String(name).trim(), created: now(), sessions: [] };
        // A changed rating ends existing sessions, so nobody keeps a higher ceiling.
        if (existing && existing.rating !== rating) guest.sessions = [];
        Object.assign(guest, { rating, expires: now() + days * DAY_MS, revoked: false, invite: hash(code) });
        if (!existing) data.guests.push(guest);
        return { code, guest: view(guest) };
      });
    },

    /** Trade an invite secret for a session secret (for the cookie). Reusable until expiry. */
    async redeem(code) {
      const offered = hash(code);
      await refresh();
      if (!data.guests.some(entry => live(entry) && sameHash(entry.invite, offered))) return null;  // bad links never take the lock
      return transaction(() => {
        const guest = data.guests.find(entry => live(entry) && sameHash(entry.invite, offered));
        if (!guest) return null;
        const session = secret();
        guest.sessions.push({ hash: hash(session), created: now(), seen: now() });
        guest.sessions = guest.sessions.slice(-MAX_SESSIONS);
        return { session, guest: view(guest) };
      });
    },

    /** The guest a session cookie belongs to, or null when unknown, expired or revoked. */
    async session(value) {
      if (!value) return null;
      await refresh();
      const offered = hash(value);
      for (const guest of data.guests) {
        if (!live(guest)) continue;
        const entry = guest.sessions.find(item => sameHash(item.hash, offered));
        if (entry) { entry.seen = now(); return view(guest); }
      }
      return null;
    },

    async revoke(name) {
      return transaction(() => {
        const guest = find(name);
        if (!guest) return false;
        guest.revoked = true;
        guest.sessions = [];
        return true;
      });
    },

    async list() { await refresh(); return data.guests.map(view); },
    flush: () => queue.catch(() => {}),
  };
}
