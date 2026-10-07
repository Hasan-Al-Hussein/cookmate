import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { API_VERSION } from '../../packages/contracts/src/constants.ts';

const host = process.env.COOKMATE_PROBE_HOST;
const port = Number(process.env.COOKMATE_PROBE_PORT ?? '8443');
const certificate = process.env.COOKMATE_PROBE_CERT_FILE;
const privateKey = process.env.COOKMATE_PROBE_KEY_FILE;
const privateV4 =
  host &&
  isIP(host) === 4 &&
  (host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host));
if (
  !privateV4 ||
  !certificate ||
  !privateKey ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
) {
  throw new Error(
    'Set an explicit RFC1918 IPv4 COOKMATE_PROBE_HOST, port 1024–65535, and existing trusted CERT_FILE/KEY_FILE paths. This probe does not create trust or alter networking.',
  );
}
const server = https.createServer(
  {
    cert: await readFile(certificate),
    key: await readFile(privateKey),
    minVersion: 'TLSv1.2',
    requestTimeout: 5000,
    headersTimeout: 5000,
    maxHeaderSize: 4096,
  },
  (request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404, { 'Content-Length': '0' });
      response.end();
      return;
    }
    const body = JSON.stringify({ status: 'ready', apiVersion: API_VERSION });
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    response.end(body);
  },
);
server.maxConnections = 4;
const lifetime = setTimeout(() => stop(), 10 * 60 * 1000);
function stop() {
  clearTimeout(lifetime);
  server.close();
  server.closeAllConnections();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.on('error', () => {
  clearTimeout(lifetime);
  process.exitCode = 1;
  console.error('Private HTTPS probe failed; inspect local TLS/binding configuration.');
});
server.listen(port, host, () =>
  console.log(
    'Private health-only HTTPS probe ready for 10 minutes. No provider or user context is accepted.',
  ),
);
