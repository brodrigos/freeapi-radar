/**
 * Valida o SMS da Brevo contra um servidor falso: endpoint, header api-key,
 * destinatário normalizado, tipo transacional e conteúdo curto.
 *
 * Uso: node test/verify-sms.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const requests = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body });
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messageId: 1511882900100020 }));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const child = spawn(process.execPath, ['cli.js', 'alert-test'], {
  cwd: resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    RADAR_SMS_ENABLED: 'true',
    RADAR_SMS_API_KEY: 'chave-sms-teste',
    RADAR_SMS_SENDER: 'Radar',
    RADAR_SMS_TO: '(55) 11 99999-9999',
    RADAR_SMS_BASE: `http://127.0.0.1:${port}`,
    RADAR_EMAIL_API_KEY: '',
    RADAR_EMAIL_PASS: '',
    RADAR_NTFY_TOPIC: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const code = await new Promise((r) => child.on('exit', r));
await new Promise((r) => setTimeout(r, 150));
server.close();

const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
const post = requests.find((r) => r.url === '/transactionalSMS/send');
const payload = post ? JSON.parse(post.body) : null;

const checks = [
  ['chamou /transactionalSMS/send', Boolean(post)],
  ['header api-key presente', post?.headers['api-key'] === 'chave-sms-teste'],
  ['remetente alfanumérico', payload?.sender === 'Radar'],
  ['telefone só com dígitos', payload?.recipient === '5511999999999'],
  ['tipo transacional', payload?.type === 'transactional'],
  ['conteúdo curto com o alerta', typeof payload?.content === 'string' && payload.content.includes('Free API Radar')],
  ['cli reportou envio por SMS', /sms:\s+enviado/.test(plain)],
  ['saída do cli é 0', code === 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}
if (payload) console.log(`\nSMS (${payload.content.length} chars):\n${payload.content}`);
if (failed) console.log(`\n--- saída ---\n${plain.trim()}`);
process.exit(failed ? 1 : 0);
