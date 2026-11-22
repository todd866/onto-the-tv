import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReportCapture } from './report-capture.js';
import { writeReport, appendReportNote, readAppInfo } from './report.js';

export function createReportService({ userData, appRoot, snapshot, capturePage, send }) {
  const requests = new Map(), saved = new Set();
  const app = readAppInfo(appRoot);
  const capture = createReportCapture({
    snapshot,
    capturePage,
    renderer: input => {
      return new Promise(resolve => {
        const requestId = randomUUID();
        const timer = setTimeout(() => { requests.delete(requestId); resolve({ channel: { unavailable: true } }); }, 1500);
        requests.set(requestId, value => { clearTimeout(timer); requests.delete(requestId); resolve(value); });
        send('report:state', { requestId, reportId: input.reportId });
      });
    },
    write: async (report, image) => {
      const { blackbox, ...data } = report;
      data.app = await app;
      if (image.error) data.errors.push({ at: data.at, type: 'screenshot', message: image.error });
      const folder = await writeReport({ userData, report: data, blackbox,
        screenshot: image.error ? undefined : image });
      saved.add(folder);
      send('report:saved', { folder, at: data.at, inPlayer: !!data.channel && !data.channel.unavailable });
      return folder;
    },
  });
  return {
    async capture(source, input = {}) {
      if (!['button', 'key', 'menu'].includes(source)) throw new Error('Invalid report source.');
      // Read the stored settings now, alongside the synchronous live snapshot.
      let settings;
      try { settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')); }
      catch (error) { settings = { unavailable: true, error: error.message }; }
      return capture(source, { ...input, storedSettings: settings });
    },
    state(value) {
      requests.get(value?.requestId)?.({ mode: value.mode, channel: value.channel || { unavailable: true } });
    },
    note(folder, note) {
      if (!saved.has(folder) || typeof note !== 'string' || note.length > 10000) throw new Error('Invalid report note.');
      return appendReportNote(folder, note);
    },
  };
}
