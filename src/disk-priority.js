import { readFile, utimes } from 'node:fs/promises';
import { writeAtomically } from './atomic-write.js';

// While the TV is playing, batch jobs on the drives it reads get out of its way (Ian, 18 Nov 2026: "Onto the TV
// isn't working"). That evening an offload was writing to the library drive while the TV streamed a Futurama
// episode from it: a 1 MB read took 17 s and the Samsung player gave up after 30 s. The fleet's disk-slot, which
// batch jobs on those drives run under, reads a priority file: a label, then one path per line. While its mtime
// is fresh (10 minutes by default) jobs on those disks wait to start, and running ones are frozen.
// This keeps that file fresh. `roots()` names the volumes the library reads; touch() is cheap to call often.
export function volumeRoots(files, exclude = []) {
  const roots = new Set();
  for (const file of files) {
    const match = /^(\/Volumes\/[^/]+)\//.exec(String(file || ''));
    if (match && !exclude.includes(match[1])) roots.add(match[1]);
  }
  return [...roots].sort();
}

export function createDiskPriority({ file, label = 'onto-the-tv', roots, now = () => Date.now(), minGapMs = 30_000, log = () => {} }) {
  let last = 0, written = '', busy = false;
  async function touch() {
    if (!file || busy || now() - last < minGapMs) return false;
    busy = true;
    try {
      const paths = roots();
      if (!paths.length) return false;
      const content = [label, ...paths].join('\n') + '\n';
      if (!written) written = await readFile(file, 'utf8').catch(() => '');
      if (content !== written) { await writeAtomically(file, content); written = content; }
      else { const at = new Date(now()); await utimes(file, at, at); }
      last = now();
      return true;
    } catch (error) { log('disk priority not marked: ' + (error.code || error.message)); return false; }
    finally { busy = false; }
  }
  return { touch };
}
