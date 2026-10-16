// File-backed iframe messages have a null origin; also require the exact window.
function installReports(api, getMode) {
  if (!api?.report) return;
  const frame = document.getElementById('channel-player');
  const row = document.getElementById('report-saved');
  const input = document.getElementById('report-note');
  const pending = new Map();
  let saved, idle;
  const post = value => frame.contentWindow?.postMessage(value, '*');
  const dismiss = () => { row.hidden = true; clearTimeout(idle); saved = null; };
  const touch = () => { clearTimeout(idle); idle = setTimeout(dismiss, 20000); };
  const fail = error => { document.getElementById('status').textContent = error.message; };
  api.onReportState(({ requestId, reportId }) => {
    const mode = getMode();
    pending.set(requestId, { mode, timer: setTimeout(() => {
      pending.delete(requestId);
      api.reportState({ requestId, mode, channel: { unavailable: true } }).catch(fail);
    }, 1500) });
    post({ type: 'onto:report-state', requestId, reportId });
  });
  api.onReportSaved(report => {
    dismiss();
    post({ type: 'onto:report-dismiss' });
    if (getMode() === 'local' && !frame.hidden && report.inPlayer !== false) {
      post({ type: 'onto:report-saved', ...report });
      return;
    }
    saved = report;
    document.getElementById('report-time').textContent = `⚑ Saved ${new Date(report.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    row.title = report.folder;
    input.value = ''; row.hidden = false; touch();
  });
  row.addEventListener('submit', event => {
    event.preventDefault();
    if (!saved) return;
    const report = saved, note = input.value;
    api.reportNote(report.folder, note).then(dismiss).catch(fail);
  });
  row.addEventListener('input', touch);
  row.addEventListener('pointerdown', touch);
  row.addEventListener('keydown', event => {
    touch();
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !row.hidden) { event.preventDefault(); dismiss(); }
  });
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== 'null' || !event.data) return;
    const data = event.data;
    if (data.type === 'onto:report') api.report(data.source === 'key' ? 'key' : 'button',
      { at: data.at, mode: getMode(), reportId: data.reportId }).catch(fail);
    if (data.type === 'onto:report-state-result' && pending.has(data.requestId)) {
      const entry = pending.get(data.requestId);
      clearTimeout(entry.timer); pending.delete(data.requestId);
      api.reportState({ requestId: data.requestId, mode: entry.mode, channel: data.state }).catch(fail);
    }
    if (data.type === 'onto:report-note') api.reportNote(data.folder, data.note).catch(fail);
    if (data.type === 'onto:blackbox') api.blackbox(data).catch(fail);
    if (data.type === 'onto:report-error') api.reportError(data).catch(fail);
  });
  window.addEventListener('error', event => api.reportError({ message: event.message, stack: event.error?.stack }).catch(() => {}));
  window.addEventListener('unhandledrejection', event => api.reportError({ message: String(event.reason), stack: event.reason?.stack }).catch(() => {}));
}
