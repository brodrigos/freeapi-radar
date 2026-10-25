/**
 * Valida o canal de e-mail sem enviar nada para fora: sobe um servidor SMTP
 * falso, roda `node cli.js alert-test` apontando para ele e confere AUTH + MIME.
 *
 * Uso: node test/verify-email.mjs
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const authLines = [];
let message = null;

const server = createServer((socket) => {
  let buf = '';
  let inData = false;
  let data = '';

  socket.on('error', () => {}); // o cliente fecha a conexão ao terminar
  socket.write('220 fake.local ESMTP ready\r\n');

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');

    if (inData) {
      data += buf;
      buf = '';
      const end = data.indexOf('\r\n.\r\n');
      if (end >= 0) {
        message = data.slice(0, end);
        inData = false;
        socket.write('250 2.0.0 Ok: queued\r\n');
      }
      return;
    }

    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      if (/^EHLO/i.test(line)) {
        socket.write('250-fake.local\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 10000000\r\n');
      } else if (/^AUTH /i.test(line)) {
        authLines.push(line);
        socket.write('235 2.7.0 Accepted\r\n');
      } else if (/^MAIL FROM/i.test(line)) {
        authLines.push(line);
        socket.write('250 2.1.0 Ok\r\n');
      } else if (/^RCPT TO/i.test(line)) {
        authLines.push(line);
        socket.write('250 2.1.5 Ok\r\n');
      } else if (/^DATA/i.test(line)) {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (/^QUIT/i.test(line)) {
        socket.write('221 Bye\r\n');
        socket.end();
      }
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const child = spawn(process.execPath, ['cli.js', 'alert-test'], {
  cwd: resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    RADAR_EMAIL_PROVIDER: 'smtp',
    RADAR_EMAIL_HOST: '127.0.0.1',
    RADAR_EMAIL_PORT: String(port),
    RADAR_EMAIL_SECURE: 'false',
    RADAR_EMAIL_USER: 'teste@exemplo.com',
    RADAR_EMAIL_PASS: 'senha-de-teste',
    RADAR_EMAIL_FROM: 'Radar <teste@exemplo.com>',
    RADAR_EMAIL_TO: 'destino@exemplo.com',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const code = await new Promise((r) => child.on('exit', r));
await new Promise((r) => setTimeout(r, 200));
server.close();

const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
const authPlain = authLines.find((l) => l.startsWith('AUTH PLAIN'));
const decodedAuth = authPlain
  ? Buffer.from(authPlain.split(' ')[2] ?? '', 'base64').toString('utf8')
  : '';

const [, rawBody = ''] = String(message ?? '').split('\r\n\r\n');
const body = Buffer.from(rawBody.replace(/\r\n/g, ''), 'base64').toString('utf8');
const subjectMatch = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(String(message ?? ''));
const subject = subjectMatch ? Buffer.from(subjectMatch[1], 'base64').toString('utf8') : null;

const checks = [
  ['servidor recebeu a mensagem', Boolean(message)],
  ['autenticou com AUTH PLAIN', Boolean(authPlain)],
  ['credencial no formato \0user\0pass', decodedAuth === '\u0000teste@exemplo.com\u0000senha-de-teste'],
  ['envelope com endereço puro', authLines.some((l) => /^MAIL FROM:<teste@exemplo\.com>/.test(l))],
  ['destinatário correto', authLines.some((l) => /^RCPT TO:<destino@exemplo\.com>/.test(l))],
  ['corpo base64 decodifica', body.includes('Radar') && body.includes('teste de alerta')],
  ['assunto com acento íntegro', Boolean(subject && subject.includes('Free API Radar'))],
  ['cli reportou envio', /email:smtp:\s+enviado/.test(plain)],
  ['saída do cli é 0', code === 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}
console.log(`\nassunto: ${subject}\ncorpo: ${body.split('\n')[0]} …`);
if (failed) console.log(`\n--- saída do cli ---\n${plain.trim()}`);
process.exit(failed ? 1 : 0);
