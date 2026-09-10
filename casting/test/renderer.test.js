import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SamsungRenderer } from '../src/renderer.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

describe('SamsungRenderer', () => {
  let server;
  let requests;

  after(() => {
    server?.close();
  });

  it('sends SetAVTransportURI then Play to the TV control URL', async () => {
    requests = [];
    server = http.createServer(async (req, res) => {
      const body = await readBody(req);
      requests.push({
        url: req.url,
        soapAction: req.headers.soapaction,
        contentType: req.headers['content-type'],
        body,
      });
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body></s:Body></s:Envelope>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const renderer = new SamsungRenderer({
      avTransportUrl: `http://127.0.0.1:${port}/upnp/control/AVTransport1`,
    });
    await renderer.play({
      url: 'http://192.0.2.20:9/token/clip.mp4',
      mimeType: 'video/mp4',
      title: 'clip.mp4',
      seekable: true,
    });

    assert.equal(requests.length, 2);
    assert.match(requests[0].soapAction, /SetAVTransportURI/);
    assert.match(requests[0].body, /CurrentURI>http:\/\/192\.0\.2\.20:9\/token\/clip\.mp4/);
    assert.match(requests[1].soapAction, /#Play"/);
    assert.match(requests[1].body, /<Speed>1<\/Speed>/);
  });

  it('surfaces Samsung/UPnP error codes instead of a generic HTTP failure', async () => {
    server?.close();
    server = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?>
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <s:Fault>
              <detail>
                <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
                  <errorCode>718</errorCode>
                  <errorDescription>Invalid MIME type</errorDescription>
                </UPnPError>
              </detail>
            </s:Fault>
          </s:Body>
        </s:Envelope>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const renderer = new SamsungRenderer({
      avTransportUrl: `http://127.0.0.1:${port}/upnp/control/AVTransport1`,
    });

    await assert.rejects(
      () => renderer.stop(),
      /UPnP 718: Invalid MIME type/,
    );
  });

  it('queues the following clip with SetNextAVTransportURI', async () => {
    server?.close();
    requests = [];
    server = http.createServer(async (req, res) => {
      const body = await readBody(req);
      requests.push({ soapAction: req.headers.soapaction, body });
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body></s:Body></s:Envelope>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const renderer = new SamsungRenderer({
      avTransportUrl: `http://127.0.0.1:${port}/upnp/control/AVTransport1`,
    });

    await renderer.setNext({
      url: 'http://192.0.2.20:9/token/next.mp4',
      mimeType: 'video/mp4',
      title: 'next.mp4',
      seekable: true,
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0].soapAction, /SetNextAVTransportURI/);
    assert.match(requests[0].body, /NextURI>http:\/\/192\.0\.2\.20:9\/token\/next\.mp4/);
  });
});
