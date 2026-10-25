/**
 * Valida o canal Brevo sem gastar chave real: servidor HTTP falso emulando
 * /account, /senders e /smtp/email do Brevo, então roda alert-test e mail-check.
 *
 * Uso: node test/verify-brevo.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const requests = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (req.url === '/account') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ email: 'conta@teste.com', companyName: 'Teste', plan: [{ type: 'free', credits: 300 }] }));
      return;
    }
    if (req.url === '/senders') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ senders: [{ email: 'teste@exemplo.com', active: true }] }));
      return;
    }
    if (req.url === '/smtp/email') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messageId: '<abc@brevo>' }));
      return;
    }
    res.writeHead(404).end('{}');
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  RADAR_EMAIL_PROVIDER: 'brevo',
  RADAR_EMAIL_API_KEY: 'chave-de-teste',
  RADAR_EMAIL_BASE: base,
  RADAR_EMAIL_FROM: 'Radar <teste@exemplo.com>',
  RADAR_EMAIL_TO: 'destino@exemplo.com',
};

const run = (args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ['cli.js', ...args], {
      cwd: resolve(import.meta.dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => done({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }));
  });

const send = await run(['alert-test']);
const check = await run(['mail-check']);
await new Promise((r) => setTimeout(r, 150));
server.close();

const post = requests.find((r) => r.url === '/smtp/email');
const payload = post ? JSON.parse(post.body) : null;

const checks = [
  ['chave enviada no header api-key', post?.headers['api-key'] === 'chave-de-teste'],
  ['remetente sem nome exibido', payload?.sender?.email === 'teste@exemplo.com'],
  ['destinatário correto', payload?.to?.[0]?.email === 'destino@exemplo.com'],
  ['assunto preenchido', typeof payload?.subject === 'string' && payload.subject.includes('Radar')],
  ['corpo em textContent', typeof payload?.textContent === 'string' && payload.textContent.includes('Radar')],
  ['alert-test reportou envio', /email:brevo:\s+enviado/.test(send.out)],
  ['mail-check validou a chave', /chave:\s+válida/.test(check.out)],
  ['mail-check viu remetente verificado', /remetente:\s+verificado/.test(check.out)],
  ['ambos saíram com código 0', send.code === 0 && check.code === 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}
console.log(`\nrequisições: ${requests.map((r) => `${r.method} ${r.url}`).join(', ')}`);
if (failed) console.log(`\n--- alert-test ---\n${send.out}\n--- mail-check ---\n${check.out}`);
process.exit(failed ? 1 : 0);
