// Offline metadata only. No network, capture, model, app-data or evidence-file access.
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 10000;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const date = value => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value));
const fail = message => { throw new TypeError(message); };
const need = (condition, message) => { if (!condition) fail(message); };

export function validateAudit(bundle) {
  need(object(bundle) && bundle.version === 1, 'Expected an audit bundle with version 1.');
  need(id(bundle.id) && text(bundle.title), 'Audit id and title are required.');
  need(['synthetic', 'real'].includes(bundle.provenance), 'provenance must be synthetic or real.');
  need(object(bundle.device) && ['samsung-tizen', 'lg-webos', 'android-google-tv', 'other', 'unknown'].includes(bundle.device.platform)
    && text(bundle.device.model) && text(bundle.device.firmware), 'Device platform, model and firmware are required (use unknown when unknown).');
  need(text(bundle.question) && text(bundle.expectedBehavior), 'Question and expectedBehavior are required.');
  const maps = {};
  for (const name of ['references', 'evidence', 'sessions', 'claims', 'comparisons']) {
    need(Array.isArray(bundle[name]) && bundle[name].length <= 1000, `${name} must be an array of at most 1000 records.`);
    maps[name] = new Map();
    for (const item of bundle[name]) {
      need(object(item) && id(item.id) && !maps[name].has(item.id), `${name}: invalid or duplicate id.`);
      maps[name].set(item.id, item);
    }
  }
  const refs = (items, name, label, nonempty = true) => {
    need(Array.isArray(items) && (!nonempty || items.length > 0) && items.every(i => maps[name].has(i))
      && new Set(items).size === items.length, `${label}: missing, duplicate or unknown ${name} reference.`);
  };
  for (const reference of bundle.references) {
    need(text(reference.title) && text(reference.url) && /^https:\/\//.test(reference.url)
      && text(reference.notes), `${reference.id}: HTTPS reference URL, title and notes required.`);
  }
  for (const evidence of bundle.evidence) {
    need(['ux-note', 'setting-record', 'traffic-summary', 'payload-analysis', 'document'].includes(evidence.kind), `${evidence.id}: unknown evidence kind.`);
    need(evidence.provenance === bundle.provenance && text(evidence.summary) && text(evidence.source)
      && date(evidence.observedAt), `${evidence.id}: provenance, summary, source and UTC observedAt required.`);
    if (evidence.sha256 !== undefined) need(/^[a-f0-9]{64}$/.test(evidence.sha256), `${evidence.id}: invalid SHA-256.`);
  }
  for (const session of bundle.sessions) {
    need(['before', 'after', 'control'].includes(session.phase) && text(session.context)
      && text(session.activity) && date(session.startedAt)
      && Number.isFinite(session.durationSeconds) && session.durationSeconds > 0, `${session.id}: invalid session context or duration.`);
    need(['enabled', 'disabled', 'unknown'].includes(session.setting) && typeof session.settingVerified === 'boolean'
      && typeof session.coverageComplete === 'boolean', `${session.id}: setting and coverage fields required.`);
    refs(session.evidenceIds, 'evidence', session.id);
    if (session.settingVerified) need(session.evidenceIds.some(i => maps.evidence.get(i).kind === 'setting-record'), `${session.id}: verified setting requires a setting-record.`);
    need(Array.isArray(session.signals) && session.signals.length <= 1000, `${session.id}: signals required.`);
    const keys = new Set();
    for (const signal of session.signals) {
      need(object(signal) && text(signal.key) && !keys.has(signal.key) && Number.isSafeInteger(signal.count)
        && signal.count >= 0 && Number.isFinite(signal.count * 60 / session.durationSeconds), `${session.id}: invalid or duplicate signal.`);
      keys.add(signal.key);
      refs(signal.evidenceIds, 'evidence', session.id);
      need(signal.evidenceIds.every(i => session.evidenceIds.includes(i)), `${session.id}: signal evidence must belong to session.`);
    }
  }
  for (const claim of bundle.claims) {
    need(['observation', 'hypothesis', 'finding'].includes(claim.status) && text(claim.statement), `${claim.id}: claim status and statement required.`);
    refs(claim.evidenceIds, 'evidence', claim.id);
    if (claim.status !== 'observation') need(text(claim.alternatives) && text(claim.limitations), `${claim.id}: alternatives and limitations required.`);
    if (claim.status === 'finding') {
      need(text(claim.reviewedBy) && date(claim.reviewedAt) && text(claim.method), `${claim.id}: finding requires review and method.`);
      need(claim.evidenceIds.some(i => maps.evidence.get(i).kind !== 'traffic-summary'), `${claim.id}: traffic alone cannot establish a finding.`);
    }
  }
  for (const comparison of bundle.comparisons) {
    need(maps.sessions.has(comparison.beforeId) && maps.sessions.has(comparison.afterId)
      && comparison.beforeId !== comparison.afterId && text(comparison.signalKey), `${comparison.id}: invalid session pair or signal.`);
  }
  return bundle;
}

export function summarizeAudit(input) {
  const bundle = validateAudit(input);
  const sessions = new Map(bundle.sessions.map(s => [s.id, s]));
  const comparisons = bundle.comparisons.map(pair => {
    const before = sessions.get(pair.beforeId), after = sessions.get(pair.afterId);
    const first = before.signals.find(s => s.key === pair.signalKey);
    const second = after.signals.find(s => s.key === pair.signalKey);
    const blockers = [];
    if (before.phase !== 'before' || after.phase !== 'after') blockers.push('phase-mismatch');
    if (before.context !== after.context || before.activity !== after.activity) blockers.push('context-mismatch');
    if (before.setting !== 'enabled' || after.setting !== 'disabled' || !before.settingVerified || !after.settingVerified) blockers.push('unverified-setting-transition');
    if (!before.coverageComplete || !after.coverageComplete) blockers.push('incomplete-coverage');
    if (Date.parse(after.startedAt) < Date.parse(before.startedAt) + before.durationSeconds * 1000) blockers.push('overlapping-or-reversed-windows');
    if (!first || !second) blockers.push('missing-signal-measurement');
    const beforePerMinute = first ? first.count * 60 / before.durationSeconds : null;
    const afterPerMinute = second ? second.count * 60 / after.durationSeconds : null;
    return { ...pair, blockers, beforeCount: first?.count ?? null, afterCount: second?.count ?? null,
      beforePerMinute, afterPerMinute,
      outcome: blockers.length ? 'inconclusive' : second.count > 0 ? 'signal-observed-after-opt-out' : 'signal-not-observed-in-window',
      evidenceIds: [...new Set([...before.evidenceIds, ...after.evidenceIds])],
    };
  });
  return { version: 1, id: bundle.id, title: bundle.title, provenance: bundle.provenance,
    question: bundle.question, expectedBehavior: bundle.expectedBehavior, device: bundle.device,
    interpretation: 'Signals describe observations, not collection purpose or proof of spying. Absence in a window does not prove absence of collection. Findings are author-reviewed assertions, not automated verification.',
    comparisons, observations: bundle.claims.filter(c => c.status === 'observation'),
    hypotheses: bundle.claims.filter(c => c.status === 'hypothesis'),
    reviewedFindings: bundle.claims.filter(c => c.status === 'finding'),
    sessions: bundle.sessions, evidence: bundle.evidence, references: bundle.references };
}
