// The TV app's page as data: its body markup and the stylesheets and scripts it loads, in order.
// The installed app is a small loader (tv/boot.js). It asks the server for this and builds the page from the
// server's copy of tv/, so an interface change reaches the TV with no reinstall (owner, 14 Nov 2026: "you're always
// giving me homework"). The same data, taken at build time, is packaged as the fallback for when the server is away.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCAL_NAME = /^[A-Za-z0-9._-]+\.(?:js|css)$/;

export function parsePage(html) {
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, ''])[1];
  const styles = [];
  for (const tag of html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/gi) || []) {
    const href = (tag.match(/href="([^"]+)"/) || [])[1];
    const id = (tag.match(/\bid="([^"]+)"/) || [])[1] || '';
    if (href && LOCAL_NAME.test(href)) styles.push({ href, id });
  }
  const scripts = [];
  for (const tag of body.match(/<script\b[^>]*src="[^"]+"[^>]*><\/script>/gi) || []) {
    const src = tag.match(/src="([^"]+)"/)[1];
    // config.js is the installed app's own (it holds the pairing token) and is never taken from the server.
    if (LOCAL_NAME.test(src) && src !== 'config.js') scripts.push(src);
  }
  return { body: body.replace(/<script\b[\s\S]*?<\/script>\s*/gi, '').trim(), styles, scripts };
}

export async function liveManifest(uiRoot) {
  const html = await readFile(join(uiRoot, 'index.html'), 'utf8');
  const page = parsePage(html);
  const hash = createHash('sha256').update(html);
  for (const name of [...page.styles.map(style => style.href), ...page.scripts]) hash.update(await readFile(join(uiRoot, name)));
  return { build: 'live-' + hash.digest('hex').slice(0, 12), ...page };
}
