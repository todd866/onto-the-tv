import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeAtomically } from './atomic-write.js';

const exec = promisify(execFile);

export function reportFolderName(at = new Date(), suffix = '') {
  const iso = new Date(at).toISOString().slice(0, 19).replaceAll(':', '-');
  return `${iso}${suffix ? `-${suffix}` : ''}`;
}

export async function writeReport({ userData, report, blackbox, screenshot, folderSuffix = '', ...fields }) {
  const frozen = structuredClone(report || fields);
  frozen.at = new Date(frozen.at || Date.now()).toISOString();
  frozen.note ??= '';
  frozen.recentHistory = (frozen.recentHistory || []).slice(0, 20);
  frozen.errors = (frozen.errors || []).slice(-50);
  if (!userData || !frozen.source) throw new TypeError('userData and source are required.');
  const log = blackbox === undefined ? undefined : JSON.stringify(blackbox, null, 2) + '\n';
  const png = screenshot === undefined ? undefined : Buffer.from(screenshot);
  const reports = join(userData, 'reports');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const base = reportFolderName(frozen.at, folderSuffix);
  let folder = join(reports, base);
  for (let suffix = 2; ; suffix += 1) {
    try { await mkdir(folder, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; folder = join(reports, `${base}-${suffix}`); }
  }
  await writeAtomically(join(folder, 'report.json'), `${JSON.stringify(frozen, null, 2)}\n`);
  if (log !== undefined) await writeAtomically(join(folder, 'blackbox.json'), log);
  if (png !== undefined) await writeAtomically(join(folder, 'window.png'), png);
  return folder;
}

export async function readAppInfo(appRoot) {
  let commit = null;
  try { ({ stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot })); commit = commit.trim(); }
  catch {}
  let version = null;
  try { version = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version || null; } catch {}
  return { version, commit };
}

export async function appendReportNote(folder, note, at = new Date()) {
  const path = join(folder, 'report.json');
  const report = JSON.parse(await readFile(path, 'utf8'));
  report.note = String(note || '');
  report.noteAt = new Date(at).toISOString();
  await writeAtomically(path, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function copyBlackboxFiles(userData, folder) {
  for (const name of ['blackbox.jsonl', 'blackbox.jsonl.previous']) {
    try { await writeAtomically(join(folder, name), await readFile(join(userData, name))); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function readHistoryTail(userData, count = 20) {
  try {
    const parsed = JSON.parse(await readFile(join(userData, 'playback-history.json'), 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, count) : [];
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
