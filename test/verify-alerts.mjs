/**
 * Valida o canal de alerta por webhook: sobe um receptor local, roda
 * `node cli.js alert-test` apontando para ele e confere o payload recebido.
 *
 * Uso: node test/verify-alerts.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const PORT = 8971;
const received = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const child = spawn(process.execPath, ['cli.js', 'alert-test'], {
  cwd: resolve(import.meta.dirname, '..'),
  env: { ...process.env, RADAR_WEBHOOK_URL: `http://127.0.0.1:${PORT}/hook` },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const code = await new Promise((r) => child.on('exit', r));

await new Promise((r) => setTimeout(r, 300));
server.close();

const payload = received[0] ? JSON.parse(received[0].body) : null;
const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
const checks = [
  ['webhook recebeu um POST', received.length === 1 && received[0].method === 'POST'],
  ['payload tem texto do alerta', Boolean(payload && typeof payload.text === 'string' && payload.text.includes('Radar'))],
  ['cli reportou envio', /webhook:\s+enviado/.test(plain)],
  ['saída do cli é 0', code === 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}
if (payload) console.log(`\nrecebido: ${payload.text.split('\n')[0]} (${payload.findings.length} item(ns))`);
process.exit(failed ? 1 : 0);
