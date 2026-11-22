# Offline TV UX and privacy audit preparation

This is an offline metadata pipeline in Onto the TV, separate from playback and
problem-report capture. It does not start Electron, read app settings/history,
scan the network, capture packets, open referenced files/URLs, execute adapters,
or call a model. Nothing is uploaded. The existing `audit/` folder is private QA
output and is not an input to this tool.

## Rehearse now

From the repository root, using the existing Node runtime:

```sh
npm run audit:tv -- validate fixtures/tv-audit/synthetic-opt-out.json
npm run audit:tv -- report fixtures/tv-audit/synthetic-opt-out.json
npm run audit:tv -- report fixtures/tv-audit/synthetic-opt-out.json /tmp/onto-tv-synthetic-report.json
```

The last command requires a new destination. It refuses overwrites, including an
existing input file. Report files are created with mode 0600; use a private parent
directory for real work. Without a destination, JSON is printed to stdout and may
be retained in terminal/agent logs. A report contains all evidence metadata and
claim text: it is **not a redacted export**. Keep real bundles and raw evidence
outside the repository; `tv-audit-private/` is also ignored as a local fallback.
No real evidence is needed for this rehearsal.

The fixture is invented. Its two windows produce 12 and 3 connections/minute,
with six connections after a recorded opt-out. The result is
`signal-observed-after-opt-out`, not a finding about actual collection.

## Bundle contract (version 1)

The fixture is a complete editable example. Required root fields:

| Field | Meaning |
| --- | --- |
| `id`, `title`, `version` | Stable identifier, full title, schema version 1 |
| `provenance` | `synthetic` or `real`; every evidence record must agree |
| `device` | `platform`, `model`, `firmware`; record unknowns explicitly |
| `question`, `expectedBehavior` | Testable question and the reasonable expectation being assessed |
| `references` | External project/document links, titles and notes; never fetched |
| `evidence` | Dated source descriptions and observations; never dereferenced |
| `sessions` | Observation windows and measured signals |
| `claims` | Observations, hypotheses and manually reviewed findings |
| `comparisons` | Explicit before/after session IDs and a matching signal key |

IDs are unique within each collection, 1–80 ASCII letters/digits/underscore/hyphen,
starting with a letter or digit. Collections allow up to 1,000 records; input is
limited to 2 MiB. Empty arrays are allowed for an early UX-only investigation.
`platform` is `samsung-tizen`, `lg-webos`, `android-google-tv`, `other` or `unknown`.
This is descriptive metadata, not a declaration that a device is supported.

Evidence kinds: `ux-note`, `setting-record`, `traffic-summary`, `payload-analysis`,
`document`. Each needs `id`, `provenance`, `source`, `summary`, `observedAt` in UTC.
Optional `sha256` identifies a separately held raw artifact; its value is syntax
checked, **not verified against that artifact**. `source` can describe a local
artifact or manual observation but grants no permission to read it. The report's
`bundleSha256` fingerprints the exact input bytes, not the truth of the content.

A session records `id`, `phase` (`before`, `after`, `control`), `context`,
`activity`, `startedAt`, positive `durationSeconds`, `setting` (`enabled`,
`disabled`, `unknown`), `settingVerified`, `coverageComplete`, `evidenceIds`, and
`signals`. Each signal has a `key`, nonnegative integer `count`, and evidence IDs
belonging to that session. Keep signal definitions identical across windows.
Use explicit zero only when it was measured; omission means unknown.
A verified setting requires a linked `setting-record`, but the tool cannot verify
that an author correctly interpreted a UI or that a vendor honored it.

For UX work, document the exact labels, defaults, navigation steps, misleading
prompts, number of actions, accessibility obstacles, and the promise made by a
setting in `ux-note`/`setting-record` evidence. Separate what the interface says
from what the device does and from what a reasonable person would expect.

Claims require `id`, `status`, `statement`, `evidenceIds`. Hypotheses and findings
also require `alternatives` and `limitations`. Findings additionally require
`reviewedBy`, `reviewedAt`, `method`, and at least one non-traffic evidence record.
These gates enforce documentation discipline, not scientific or moral truth.
The report labels them `reviewedFindings`; it never promotes claims itself.

## Comparison limits

A comparison has `id`, `beforeId`, `afterId`, `signalKey`. Automatic summaries
require before/after phases, identical context and activity descriptions, verified
enabled→disabled settings, complete stated coverage, nonoverlapping chronological
windows, and measurements in both windows. Otherwise the result is `inconclusive`
with explicit blockers. Rates account for unequal durations but do not establish
statistical significance. Context equality is an author assertion, not a control
of real experimental conditions.

Nonzero after traffic is a persistent **signal**, not proof of spying or even of
personal-data collection. DNS, TLS endpoints, bytes or connections alone cannot
identify payloads, purpose, recipients' use, or consent compliance. A zero is only
“not observed in this window”; sampling gaps, caching, alternate paths, delayed
transmission and encrypted payloads remain possible. Findings about opt-out
violations need evidence of the setting's promise, relevant data/purpose, valid
comparisons and competing explanations. Repeat trials and separate controls are
future manual work; the pipeline does not infer causation or legal violations.

## Staged project plan

1. **Now — offline foundation:** validated metadata, evidence references, explicit
   claim states, comparison blockers, private new-file reports, synthetic tests.
   No changes to playback, history, videos, app launch or TV control.
2. **Next — offline UX workbench:** a fixture-driven viewer/editor using this
   module; structured navigation/task measurements, contradictory evidence,
   per-claim review and deliberate redacted export. Add schema migration before
   changing the version-1 contract. No live backend is needed.
3. **Research ledger:** start with [dated platform references](tv-project-references.md); record candidate open-source projects as references with
   platform, exact model/firmware support, license, maintenance date, capabilities,
   limitations and source links in notes. Third-party package-disable lists are
   unverified plans, never an executable feed. Distinguish launchers, debloat,
   developer-mode access and rooting; a shared platform name is not compatibility.
   A later proposal should describe each action, expected benefit, failure modes,
   reversal procedure and evidence/confidence before considering an adapter.
4. **Only after separate explicit authorization and participant consent:** agree
   on a device, owner, scope, evidence retention and controlled trial design;
   document a baseline, opt-out transitions, matched activity and repeat/control
   windows. A housemate's interest is not consent. Capture, discovery, installation,
   credentials, modifications and model calls remain outside this increment.
5. **Later — empirical conclusions:** independently review payload/behavior and UX
   evidence, contradictions and uncertainty before publishing any finding. Raw
   evidence stays local by default; any sharing/redaction needs a deliberate path.

## Checks

`node --test src/tv-audit.test.js` covers valid reports, rates, zero vs missing,
confounding/coverage gates, evidence integrity, review requirements, privacy mode,
input size, invalid JSON and refusal to overwrite. The test is included by the
existing `npm test` glob. There are no new dependencies, live adapters, renderer
changes, hosted services or automatic app startup hooks.
