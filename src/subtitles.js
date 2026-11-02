import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export function srtToVtt(text) {
  let body = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (/^WEBVTT\b/.test(body)) return body.endsWith('\n') ? body : `${body}\n`;
  const cues = [];
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n');
    let index = 0;
    if (/^\d+$/.test(lines[0].trim())) index = 1;
    if (!lines[index] || !lines[index].includes('-->')) continue;
    const timing = lines[index].replace(/(\d),(\d{3})/g, '$1.$2');
    cues.push(`${timing}\n${lines.slice(index + 1).join('\n')}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}${cues.length ? '\n' : ''}`;
}

export function matchingSidecars(videoFile, names) {
  const base = basename(videoFile, extname(videoFile));
  const tracks = [];
  for (const name of names || []) {
    if (typeof name !== 'string' || !name || name !== basename(name)) continue;
    if (!/\.(srt|vtt)$/i.test(name)) continue;
    const stem = name.replace(/\.(srt|vtt)$/i, '');
    if (stem !== base && !stem.startsWith(`${base}.`)) continue;
    const lang = stem === base ? '' : stem.slice(base.length + 1);
    tracks.push({ id: name, label: lang || 'Subtitles', lang: lang.split('.')[0] || '' });
  }
  tracks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tracks;
}

export async function listSidecars(videoFile) {
  let names = [];
  try { names = await readdir(dirname(videoFile)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return matchingSidecars(videoFile, names);
}

export async function readSubtitle(videoFile, name) {
  const tracks = await listSidecars(videoFile);
  if (!tracks.some(track => track.id === name)) {
    throw Object.assign(new Error('No subtitles.'), { status: 404 });
  }
  const text = await readFile(join(dirname(videoFile), name), 'utf8');
  if (String(name).toLowerCase().endsWith('.vtt')) {
    const trimmed = text.replace(/^\uFEFF/, '');
    if (/^WEBVTT\b/.test(trimmed.trim())) return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
  }
  return srtToVtt(text);
}
