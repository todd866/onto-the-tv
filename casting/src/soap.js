import { escapeXml, xmlText } from './xml.js';
import { buildContentFeatures, parseClock, secondsToClock, upnpClassForMime } from './dlna.js';

const AV_NS = 'urn:schemas-upnp-org:service:AVTransport:1';

export function buildDidl({
  url,
  mimeType,
  title,
  seekable = true,
  transcoded = false,
  durationSeconds,
} = {}) {
  const protocolInfo = `http-get:*:${mimeType}:${buildContentFeatures({ mimeType, seekable, transcoded })}`;
  const durationAttr =
    durationSeconds != null ? ` duration="${secondsToClock(durationSeconds)}"` : '';
  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:sec="http://www.sec.co.kr/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    '<item id="1" parentID="0" restricted="1">',
    xmlText('dc:title', title || 'Media'),
    xmlText('upnp:class', upnpClassForMime(mimeType)),
    `<res protocolInfo="${escapeXml(protocolInfo)}"${durationAttr}>${escapeXml(url)}</res>`,
    '</item>',
    '</DIDL-Lite>',
  ].join('');
}

export function buildSoap(action, fields, serviceNs = AV_NS, options = {}) {
  const raw = new Set(options.rawFields || []);
  const inner = Object.entries(fields)
    .map(([name, value]) => (
      raw.has(name) ? `<${name}>${value ?? ''}</${name}>` : xmlText(name, value ?? '')
    ))
    .join('');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${action} xmlns:u="${serviceNs}">`,
    inner,
    `</u:${action}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

export function parseSoapFault(xml) {
  const code = tagValue(xml, 'errorCode');
  const description = tagValue(xml, 'errorDescription');
  if (!code && !description) return null;
  return { code: Number(code) || 0, description: description || 'UPnP error' };
}

export function parseTransportInfo(xml) {
  return {
    state: tagValue(xml, 'CurrentTransportState') || 'UNKNOWN',
    status: tagValue(xml, 'CurrentTransportStatus') || 'UNKNOWN',
    speed: tagValue(xml, 'CurrentSpeed') || '1',
  };
}

export function parsePositionInfo(xml) {
  return {
    durationSeconds: parseClock(tagValue(xml, 'TrackDuration')),
    positionSeconds: parseClock(tagValue(xml, 'RelTime')),
    uri: tagValue(xml, 'TrackURI'),
    metadata: tagValue(xml, 'TrackMetaData'),
  };
}

export function soapActionHeader(action, serviceNs = AV_NS) {
  return `"${serviceNs}#${action}"`;
}
