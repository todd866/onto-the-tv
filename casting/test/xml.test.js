import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml } from '../src/xml.js';

describe('escapeXml', () => {
  it('escapes markup and quotes so DIDL can sit inside SOAP text', () => {
    assert.equal(
      escapeXml(`Title & <One> "two"`),
      'Title &amp; &lt;One&gt; &#34;two&#34;',
    );
  });
});
