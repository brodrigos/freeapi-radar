/**
 * Testa o canal ntfy de verdade (ntfy.sh público): publica em um tópico aleatório
 * e relê a mensagem pelo próprio servidor, provando o caminho de ponta a ponta.
 *
 * Uso: node test/verify-ntfy.mjs
 */
import { randomBytes } from 'node:crypto';
import { readNtfy, sendNtfy } from '../src/sms.js';

const topic = `radar-teste-${randomBytes(6).toString('hex')}`;
const message = `teste ${new Date().toISOString()}`;

let sent;
try {
  sent = await sendNtfy({ topic, message, title: 'Free API Radar — teste' });
} catch (err) {
  console.log(`⚠ ntfy.sh inacessível daqui (${err.message}) — teste pulado`);
  process.exit(0);
}

const recent = [];
if (sent.ok) {
  // O servidor público pode levar um instante para indexar: tenta algumas vezes.
  for (let attempt = 0; attempt < 4; attempt++) {
    const batch = await readNtfy({ topic, since: '5m' }).catch(() => []);
    recent.push(...batch);
    if (recent.some((m) => String(m.message ?? '').includes(message))) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
}
const found = recent.some((m) => String(m.message ?? '').includes(message));

const checks = [
  ['publicou no tópico', sent.ok && sent.status === 200],
  ['mensagem recuperável pelo servidor', found],
  ['servidor público respondeu sem conta/chave', sent.ok],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}
console.log(`\ntópico: ${topic} · mensagens lidas: ${recent.length}`);
console.log(`no celular: instale o app ntfy e assine o mesmo tópico`);
process.exit(failed ? 1 : 0);
