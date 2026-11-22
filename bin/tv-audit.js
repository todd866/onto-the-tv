#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MAX_BUNDLE_BYTES, validateAudit, summarizeAudit } from '../src/tv-audit.js';

export const USAGE = `Usage: npm run audit:tv -- validate BUNDLE.json
       npm run audit:tv -- report BUNDLE.json [NEW_REPORT.json]

Offline metadata only. No referenced files or URLs are opened.
Without NEW_REPORT.json, report JSON is printed to stdout. Output files never overwrite.
Try fixtures/tv-audit/synthetic-opt-out.json; keep real bundles outside the repository.
`;
export async function main(args = process.argv.slice(2), io = console) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { io.log(USAGE); return 0; }
  const [command, source, destination] = args;
  if (!['validate', 'report'].includes(command) || !source || args.length > (command === 'validate' ? 2 : 3)) {
    io.error(USAGE); return 2;
  }
  try {
    const file = await open(source, 'r');
    let bytes;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error('Bundle must be a regular file no larger than 2 MiB.');
      // Bounded read also protects against a file growing after stat.
      const buffer = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds 2 MiB.');
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
    const bundle = validateAudit(JSON.parse(bytes.toString('utf8')));
    const result = command === 'validate' ? { valid: true, id: bundle.id, provenance: bundle.provenance } : {
      ...summarizeAudit(bundle), bundleSha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const serialized = JSON.stringify(result, null, 2) + '\n';
    if (destination) {
      const output = await open(destination, 'wx', 0o600);
      try { await output.writeFile(serialized); await output.sync(); } finally { await output.close(); }
      io.log(JSON.stringify({ saved: destination }));
    } else io.log(serialized.trimEnd());
    return 0;
  } catch (error) { io.error(error.message); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
