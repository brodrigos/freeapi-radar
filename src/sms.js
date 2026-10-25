// Canais de celular: SMS pela Brevo (pago por crédito) e ntfy (push gratuito, sem conta).

import { request } from './http.js';

/**
 * SMS transacional da Brevo (api.brevo.com/v3/transactionalSMS/send).
 * Custo: crédito de SMS comprado à parte — não entra nos 300 e-mails/dia.
 * `sender` é alfanumérico de até 11 caracteres (no Brasil pode exigir registro prévio).
 */
export async function sendBrevoSms({ apiKey, sender, recipient, content, baseUrl }) {
  const base = baseUrl || 'https://api.brevo.com/v3';
  const res = await request(`${base}/transactionalSMS/send`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender,
      recipient: String(recipient).replace(/[^\d+]/g, ''),
      content,
      type: 'transactional',
      unicodeEnabled: /[^\x00-\x7F]/.test(content),
      tag: 'freeapi-radar',
    }),
    timeout: 20000,
    retries: 0,
  });

  let detail = res.text.slice(0, 300);
  try {
    const json = JSON.parse(res.text);
    detail = json.message ?? json.code ?? json.messageId ?? detail;
  } catch {
    /* resposta não-JSON */
  }
  return { provider: 'brevo-sms', ok: res.ok, status: res.status, detail };
}

/** Créditos de SMS restantes na conta Brevo (para avisar antes de acabar). */
export async function probeBrevoSms({ apiKey, baseUrl }) {
  const base = baseUrl || 'https://api.brevo.com/v3';
  try {
    const res = await request(`${base}/account`, {
      headers: { 'api-key': apiKey, accept: 'application/json' },
      timeout: 15000,
      retries: 0,
    });
    const json = JSON.parse(res.text);
    const plans = Array.isArray(json.plan) ? json.plan : [];
    const sms = plans.find((p) => /sms/i.test(String(p.type ?? '')));
    return { ok: res.ok, status: res.status, email: json.email ?? null, smsCredits: sms?.credits ?? null, plans };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

/** Cabeçalhos HTTP só aceitam bytes latinos: tira acento e troca o resto. */
const asciiHeader = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '-');

/**
 * ntfy: push para o celular via HTTPS, sem cadastro. Publica em um "tópico" e o
 * app assina o mesmo tópico. Alternativa gratuita ao SMS (que é pago).
 */
export async function sendNtfy({ topic, server = 'https://ntfy.sh', title, message, priority = 3, tags = 'satellite' }) {
  const base = String(server || 'https://ntfy.sh').replace(/\/+$/, '');
  const res = await request(`${base}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      title: asciiHeader(title),
      priority: String(priority),
      tags: asciiHeader(tags),
      'content-type': 'text/plain; charset=utf-8',
    },
    body: message,
    timeout: 15000,
    retries: 0,
  });
  return { provider: 'ntfy', ok: res.ok, status: res.status, detail: res.text.slice(0, 200) };
}

/** Lê as mensagens recentes de um tópico ntfy (usado no diagnóstico/teste). */
export async function readNtfy({ topic, server = 'https://ntfy.sh', since = '10m' }) {
  const base = String(server || 'https://ntfy.sh').replace(/\/+$/, '');
  const res = await request(`${base}/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since)}`, {
    timeout: 15000,
    retries: 0,
  });
  const messages = res.text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((m) => m && m.event === 'message');
  return messages;
}
