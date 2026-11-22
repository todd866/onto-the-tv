import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContentFeatures, secondsToClock, parseClock } from '../src/dlna.js';

describe('buildContentFeatures', () => {
  it('marks a seekable MP4 as byte-seekable, not converted', () => {
    assert.equal(
      buildContentFeatures({ mimeType: 'video/mp4', seekable: true, transcoded: false }),
      'DLNA.ORG_PN=AVC_MP4_MP_SD_AAC_MULT5;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
    );
  });

  it('marks transcoded MPEG-TS as converted and not seekable', () => {
    assert.equal(
      buildContentFeatures({ mimeType: 'video/mpeg', seekable: false, transcoded: true }),
      'DLNA.ORG_PN=MPEG1;DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000',
    );
  });
});

describe('clock conversion', () => {
  it('round-trips seconds through DLNA clock format', () => {
    assert.equal(secondsToClock(6176), '01:42:56');
    assert.equal(parseClock('01:42:56'), 6176);
  });
});
