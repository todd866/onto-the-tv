#!/usr/bin/env node
// Invite someone to the phone web app. Run on the TV Mac (the M2).
//   node bin/invite.js "Dave" [--rating G|PG|M] [--days 7]   new or renewed link, printed once
//   node bin/invite.js --list
//   node bin/invite.js --revoke "Dave"
// The link's base is this Mac's Tailscale Funnel name (or --base https://…).
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createGuestInvites } from '../src/guest-invites.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1] : fallback; };
const flag = name => { const at = args.indexOf(name); return at >= 0 ? (args.splice(at, 1), true) : false; };
const appData = option('--app-data', join(homedir(), 'Library/Application Support/Onto the TV'));
const data = join(appData, 'tv-server');
await mkdir(data, { recursive: true, mode: 0o700 });
const invites = await createGuestInvites(join(data, 'guests.json'));

function base() {
  for (const exe of ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale']) {
    try {
      const name = JSON.parse(execFileSync(exe, ['status', '--json'], { encoding: 'utf8' })).Self.DNSName.replace(/\.$/, '');
      if (name) return `https://${name}`;
    } catch {}
  }
  return 'https://<this-mac>.ts.net';
}

const day = ms => new Date(ms).toISOString().slice(0, 10);
const revoke = option('--revoke');
if (flag('--list')) {
  for (const guest of await invites.list()) {
    const state = guest.revoked ? 'revoked' : guest.expires < Date.now() ? 'expired' : `until ${day(guest.expires)}`;
    console.log(`${guest.name.padEnd(16)} ${guest.rating.padEnd(3)} ${state.padEnd(17)} ${guest.sessions} device(s)`);
  }
} else if (revoke) {
  console.log((await invites.revoke(revoke)) ? `revoked ${revoke}` : `no guest called ${revoke}`);
} else if (args[0]) {
  const rating = option('--rating', 'M'), days = Number(option('--days', 7));
  const url = option('--base', base());
  const { code, guest } = await invites.invite(args.join(' '), { rating, days });
  console.log(`${guest.name} · up to ${guest.rating} · until ${day(guest.expires)}`);
  console.log(`${url}/w/${code}`);
} else {
  console.log('usage: node bin/invite.js "Name" [--rating G|PG|M] [--days 7] | --list | --revoke "Name"');
  process.exit(1);
}
