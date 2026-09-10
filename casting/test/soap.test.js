import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDidl, buildSoap, parseSoapFault, parseTransportInfo, parsePositionInfo } from '../src/soap.js';

describe('buildDidl', () => {
  it('builds a video item with escaped title and DLNA protocolInfo', () => {
    const didl = buildDidl({
      url: 'http://192.0.2.20:8787/abc/movie.mp4',
      mimeType: 'video/mp4',
      title: 'Cats & Dogs',
      seekable: true,
      transcoded: false,
      durationSeconds: 12,
    });

    assert.match(didl, /<dc:title>Cats &amp; Dogs<\/dc:title>/);
    assert.match(didl, /object\.item\.videoItem\.movie/);
    assert.match(didl, /protocolInfo="http-get:\*:video\/mp4:DLNA\.ORG_PN=AVC_MP4_MP_SD_AAC_MULT5;DLNA\.ORG_OP=01/);
    assert.match(didl, /duration="00:00:12"/);
    assert.match(didl, />http:\/\/192\.0\.2\.20:8787\/abc\/movie\.mp4<\/res>/);
  });

  it('classifies audio as a music track', () => {
    const didl = buildDidl({
      url: 'http://host/track.m4a',
      mimeType: 'audio/mp4',
      title: 'Art Track',
      seekable: true,
    });
    assert.match(didl, /object\.item\.audioItem\.musicTrack/);
  });
});

describe('buildSoap', () => {
  it('wraps SetAVTransportURI and XML-escapes nested DIDL', () => {
    const body = buildSoap('SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: 'http://host/movie.mp4',
      CurrentURIMetaData: buildDidl({
        url: 'http://host/movie.mp4',
        mimeType: 'video/mp4',
        title: 'Movie',
        seekable: true,
      }),
    });

    assert.match(body, /xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/);
    assert.match(body, /<CurrentURI>http:\/\/host\/movie\.mp4<\/CurrentURI>/);
    assert.match(body, /<CurrentURIMetaData>&lt;DIDL-Lite/);
    assert.doesNotMatch(body, /<CurrentURIMetaData><DIDL-Lite/);
  });

  it('builds Play with Speed 1', () => {
    const body = buildSoap('Play', { InstanceID: '0', Speed: '1' });
    assert.match(body, /<u:Play /);
    assert.match(body, /<Speed>1<\/Speed>/);
  });
});

describe('SOAP response parsers', () => {
  it('extracts UPnP error codes from a SOAP fault', () => {
    const fault = parseSoapFault(`<?xml version="1.0"?>
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
        <s:Body>
          <s:Fault>
            <detail>
              <u:UPnPError xmlns:u="urn:schemas-upnp-org:control-1-0">
                <errorCode>701</errorCode>
                <errorDescription>Transition not available</errorDescription>
              </u:UPnPError>
            </detail>
          </s:Fault>
        </s:Body>
      </s:Envelope>`);
    assert.deepEqual(fault, { code: 701, description: 'Transition not available' });
  });

  it('parses GetTransportInfo fields', () => {
    const info = parseTransportInfo(`
      <CurrentTransportState>STOPPED</CurrentTransportState>
      <CurrentTransportStatus>OK</CurrentTransportStatus>
      <CurrentSpeed>1</CurrentSpeed>`);
    assert.deepEqual(info, { state: 'STOPPED', status: 'OK', speed: '1' });
  });

  it('parses GetPositionInfo fields', () => {
    const info = parsePositionInfo(`
      <TrackDuration>00:01:30</TrackDuration>
      <RelTime>00:00:12</RelTime>
      <AbsTime>NOT_IMPLEMENTED</AbsTime>
      <TrackURI>http://host/movie.mp4</TrackURI>`);
    assert.equal(info.durationSeconds, 90);
    assert.equal(info.positionSeconds, 12);
    assert.equal(info.uri, 'http://host/movie.mp4');
  });
});
