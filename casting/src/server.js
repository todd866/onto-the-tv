import http from 'node:http';
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, basename } from 'node:path';
import { buildContentFeatures, mimeFromPath } from './dlna.js';

export function parseRange(header, size) {
  if (!header || !Number.isSafeInteger(size) || size <= 0) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export class MediaServer {
  #responses = new Map();
  #statFile;

  constructor({ host = '127.0.0.1', port = 0, statFile = stat } = {}) {
    this.host = host;
    this.port = port;
    this.#statFile = statFile;
    this.items = new Map();
    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this;
  }

  serveFile({ filePath, mimeType, title, seekable = true, transcoded = false, durationSeconds }) {
    const token = randomBytes(18).toString('hex');
    const ext = extname(filePath) || '';
    const path = `/${token}/${encodeURIComponent(basename(filePath) || `media${ext}`)}`;
    const item = {
      filePath,
      mimeType: mimeType || mimeFromPath(filePath),
      title: title || basename(filePath),
      seekable,
      transcoded,
      durationSeconds,
      path,
      url: `http://${this.host}:${this.port}${path}`,
    };
    this.items.set(path, item);
    return item;
  }

  clear() {
    this.items.clear();
    for (const [response, { stream }] of this.#responses) {
      stream?.destroy();
      response.destroy();
    }
    this.#responses.clear();
  }

  revoke(url) {
    const item = [...this.items.values()].find(item => item.url === url);
    if (!item) return;
    this.items.delete(item.path);
    for (const [response, active] of this.#responses) {
      if (active.path !== item.path) continue;
      active.stream?.destroy();
      response.destroy();
      this.#responses.delete(response);
    }
  }

  async close() {
    this.clear();
    const closing = new Promise((resolve) => this.server.close(resolve));
    this.server.closeAllConnections?.();
    await closing;
  }

  #handle(req, res) {
    let url;
    try { url = new URL(req.url, `http://${this.host}:${this.port}`); }
    catch { res.writeHead(400); res.end(); return; }
    const item = this.items.get(url.pathname);
    if (!item) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    this.#responses.set(res, { path: item.path, stream: null });
    res.once('close', () => this.#responses.delete(res));
    const revoked = () => res.destroyed || this.items.get(url.pathname) !== item;
    this.#statFile(item.filePath)
      .then((info) => {
        if (revoked()) return;
        if (!info.isFile()) { res.writeHead(404); res.end(); return; }
        this.#send(req, res, item, info.size);
      })
      .catch(() => {
        if (revoked()) return;
        res.writeHead(404);
        res.end();
      });
  }

  #send(req, res, item, size) {
    const features = buildContentFeatures({
      mimeType: item.mimeType,
      seekable: item.seekable,
      transcoded: item.transcoded,
    });
    const headers = {
      'Content-Type': item.mimeType,
      'Accept-Ranges': item.seekable ? 'bytes' : 'none',
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': features,
      'realTimeInfo.dlna.org': 'DLNA.ORG_TLAG=*',
    };

    const range = item.seekable ? parseRange(req.headers.range, size) : null;
    if (req.headers.range && !range) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const length = end - start + 1;
    headers['Content-Length'] = String(length);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if (size === 0) { res.end(); return; }
    const stream = fs.createReadStream(item.filePath, { start, end });
    this.#responses.set(res, { path: item.path, stream });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}
