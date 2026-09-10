import http from 'node:http';
import { secondsToClock } from './dlna.js';
import { buildDidl, buildSoap, parsePositionInfo, parseSoapFault, parseTransportInfo, soapActionHeader } from './soap.js';

const AV_NS = 'urn:schemas-upnp-org:service:AVTransport:1';

export class SamsungRenderer {
  constructor({
    avTransportUrl,
    fetchImpl = fetch,
    timeoutMs = 8000,
  } = {}) {
    if (!avTransportUrl) throw new Error('avTransportUrl is required');
    this.avTransportUrl = avTransportUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async play(media) {
    try {
      await this.setUri(media);
    } catch (error) {
      if (!/UPnP 701/.test(error.message)) throw error;
      await this.stop();
      await this.setUri(media);
    }
    await this.invoke('Play', { InstanceID: '0', Speed: '1' });
  }

  async setUri(media) {
    const metadata = buildDidl(media);
    const fields = {
      InstanceID: '0',
      CurrentURI: media.url,
      CurrentURIMetaData: metadata,
    };
    try {
      await this.invoke('SetAVTransportURI', fields);
    } catch (error) {
      await this.invoke('SetAVTransportURI', fields, { rawFields: ['CurrentURIMetaData'] });
    }
  }

  async setNext(media) {
    const metadata = buildDidl(media);
    const fields = {
      InstanceID: '0',
      NextURI: media.url,
      NextURIMetaData: metadata,
    };
    try {
      await this.invoke('SetNextAVTransportURI', fields);
    } catch (error) {
      await this.invoke('SetNextAVTransportURI', fields, { rawFields: ['NextURIMetaData'] });
    }
  }

  pause() {
    return this.invoke('Pause', { InstanceID: '0' });
  }

  resume() {
    return this.invoke('Play', { InstanceID: '0', Speed: '1' });
  }

  stop() {
    return this.invoke('Stop', { InstanceID: '0' });
  }

  seek(seconds) {
    return this.invoke('Seek', {
      InstanceID: '0',
      Unit: 'REL_TIME',
      Target: secondsToClock(seconds),
    });
  }

  async transportInfo() {
    const xml = await this.invoke('GetTransportInfo', { InstanceID: '0' });
    return parseTransportInfo(xml);
  }

  async positionInfo() {
    const xml = await this.invoke('GetPositionInfo', { InstanceID: '0' });
    return parsePositionInfo(xml);
  }

  async invoke(action, fields, options = {}) {
    const body = buildSoap(action, fields, AV_NS, options);
    const url = new URL(this.avTransportUrl);
    let xml;
    let status;
    if (this.fetchImpl !== fetch) {
      const response = await this.fetchImpl(this.avTransportUrl, {
        method: 'POST',
        headers: {
          SOAPAction: soapActionHeader(action, AV_NS),
          'Content-Type': 'text/xml; charset="utf-8"',
          Connection: 'close',
        },
        body,
      });
      status = response.status;
      xml = await response.text();
    } else {
      const result = await postSoap(url, action, body, this.timeoutMs);
      status = result.status;
      xml = result.xml;
    }
    if (status < 200 || status >= 300) {
      const fault = parseSoapFault(xml);
      if (fault) throw new Error(`UPnP ${fault.code}: ${fault.description}`);
      throw new Error(`TV SOAP ${action} HTTP ${status}`);
    }
    const fault = parseSoapFault(xml);
    if (fault) throw new Error(`UPnP ${fault.code}: ${fault.description}`);
    return xml;
  }
}

function postSoap(url, action, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        SOAPAction: soapActionHeader(action, AV_NS),
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        xml: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`TV SOAP ${action} timed out`));
    });
    req.on('error', (error) => reject(new Error(`TV SOAP ${action} failed: ${error.message}`)));
    req.end(body);
  });
}
