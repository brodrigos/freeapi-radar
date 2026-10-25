// Envio de e-mail sem dependências: SMTP direto (Gmail/qualquer relay) ou API HTTP.
// SMTP feito à mão com node:net/node:tls — EHLO, STARTTLS, AUTH PLAIN/LOGIN, DATA.

import net from 'node:net';
import tls from 'node:tls';
import { request } from './http.js';

const CRLF = '\r\n';

/* ------------------------------------------------------------------ MIME */

function rfc2047(value) {
  // Cabeçalhos precisam de encoding quando têm acento/emoji.
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildMessage({ from, to, subject, text, date = new Date() }) {
  const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1' + CRLF);
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${rfc2047(subject)}`,
    `Date: ${date.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@freeapi-radar>`,
    'X-Mailer: freeapi-radar',
    '',
    body,
  ].join(CRLF);
}

/* ------------------------------------------------------------------ SMTP */

class SmtpError extends Error {
  constructor(message, reply) {
    super(message);
    this.name = 'SmtpError';
    this.reply = reply;
  }
}

function makeChannel(socket) {
  let buffer = '';
  let waiter = null;

  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    pump();
  };

  const pump = () => {
    if (!waiter) return;
    const match = /^([\s\S]*?\d{3}[ ][^\r\n]*\r\n)/.exec(buffer);
    if (!match) return;
    const reply = match[1];
    buffer = buffer.slice(reply.length);
    const pendingWaiter = waiter;
    waiter = null;
    pendingWaiter.resolve(reply);
  };

  socket.on('data', onData);

  return {
    read(timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        const timer = setTimeout(() => {
          if (waiter) {
            waiter = null;
            reject(new SmtpError('timeout esperando resposta do servidor SMTP'));
          }
        }, timeoutMs);
        timer.unref?.();
        const done = (fn) => (v) => {
          clearTimeout(timer);
          fn(v);
        };
        waiter.resolve = done(resolve);
        waiter.reject = done(reject);
        pump();
      });
    },
    /** Solta o listener: obrigatório antes de trocar o socket pelo TLS. */
    detach() {
      socket.off('data', onData);
    },
  };
}

const codeOf = (reply) => Number(String(reply).slice(0, 3));

/** Envelope SMTP precisa do endereço puro, mesmo que o cabeçalho tenha nome exibido. */
export const bareAddress = (value) => {
  const inside = /<([^>]+)>/.exec(String(value ?? ''));
  return (inside ? inside[1] : String(value ?? '')).trim();
};

function connectSocket({ host, port, secure, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    socket.setTimeout(timeout);
    const onError = (err) => reject(new SmtpError(`conexão com ${host}:${port} falhou: ${err.message}`));
    socket.once('error', onError);
    const event = secure ? 'secureConnect' : 'connect';
    socket.once(event, () => {
      socket.removeListener('error', onError);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

async function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host }, () => resolve(secured));
    secured.once('error', (err) => reject(new SmtpError(`STARTTLS falhou: ${err.message}`)));
  });
}

/** Envia um e-mail por SMTP. Lança SmtpError com o código/resposta em caso de falha. */
export async function sendSmtp({ host, port = 465, secure = true, user, pass, from, to, subject, text, timeout = 25000 }) {
  let socket = await connectSocket({ host, port, secure, timeout });
  let channel = makeChannel(socket);

  const quit = () => {
    try {
      socket.write(`QUIT${CRLF}`);
      socket.destroy();
    } catch {
      /* ignore */
    }
  };

  try {
    const greeting = await channel.read(timeout);
    if (codeOf(greeting) !== 220) throw new SmtpError(`saudação inesperada: ${greeting.trim()}`, greeting);

    const ehloName = 'freeapi-radar.local';
    socket.write(`EHLO ${ehloName}${CRLF}`);
    let reply = await channel.read(timeout);
    if (codeOf(reply) !== 250) throw new SmtpError(`EHLO recusado: ${reply.trim()}`, reply);

    const capabilities = reply.toUpperCase();
    if (!secure && capabilities.includes('STARTTLS')) {
      socket.write(`STARTTLS${CRLF}`);
      const starttls = await channel.read(timeout);
      if (codeOf(starttls) !== 220) throw new SmtpError(`STARTTLS recusado: ${starttls.trim()}`, starttls);
      channel.detach();
      socket = await upgradeTls(socket, host);
      channel = makeChannel(socket);
      socket.write(`EHLO ${ehloName}${CRLF}`);
      reply = await channel.read(timeout);
      if (codeOf(reply) !== 250) throw new SmtpError(`EHLO pós-STARTTLS recusado: ${reply.trim()}`, reply);
    }

    if (user && pass) {
      const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
      socket.write(`AUTH PLAIN ${token}${CRLF}`);
      const auth = await channel.read(timeout);
      const authCode = codeOf(auth);
      if (authCode === 235) {
        /* autenticado */
      } else if (authCode === 504 || authCode === 334 || authCode === 535) {
        // 504 = mecanismo não suportado; tenta LOGIN
        if (authCode === 504) {
          socket.write(`AUTH LOGIN${CRLF}`);
          if (codeOf(await channel.read(timeout)) !== 334) throw new SmtpError('AUTH LOGIN não aceito', auth);
          socket.write(`${Buffer.from(user).toString('base64')}${CRLF}`);
          if (codeOf(await channel.read(timeout)) !== 334) throw new SmtpError('usuário recusado', auth);
          socket.write(`${Buffer.from(pass).toString('base64')}${CRLF}`);
          const login = await channel.read(timeout);
          if (codeOf(login) !== 235) throw new SmtpError(`autenticação recusada: ${login.trim()}`, login);
        } else {
          throw new SmtpError(`autenticação recusada: ${auth.trim()}`, auth);
        }
      } else {
        throw new SmtpError(`AUTH inesperado: ${auth.trim()}`, auth);
      }
    }

    socket.write(`MAIL FROM:<${bareAddress(from)}>${CRLF}`);
    let step = await channel.read(timeout);
    if (codeOf(step) !== 250) throw new SmtpError(`MAIL FROM recusado: ${step.trim()}`, step);

    socket.write(`RCPT TO:<${bareAddress(to)}>${CRLF}`);
    step = await channel.read(timeout);
    if (![250, 251].includes(codeOf(step))) throw new SmtpError(`RCPT TO recusado: ${step.trim()}`, step);

    socket.write(`DATA${CRLF}`);
    step = await channel.read(timeout);
    if (codeOf(step) !== 354) throw new SmtpError(`DATA recusado: ${step.trim()}`, step);

    // Dot-stuffing: linhas que começam com "." viram "..".
    const message = buildMessage({ from, to, subject, text }).replace(/\r\n\./g, `${CRLF}..`);
    socket.write(message + CRLF + `.${CRLF}`);
    step = await channel.read(timeout);
    if (codeOf(step) !== 250) throw new SmtpError(`mensagem recusada: ${step.trim()}`, step);

    quit();
    return { provider: 'smtp', ok: true, status: 250, detail: step.trim().slice(0, 120) };
  } catch (err) {
    quit();
    throw err;
  }
}

/* ------------------------------------------------------------- APIs HTTP */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 403/429/5xx da Brevo são intermitentes durante propagação: vale insistir. */
const TRANSIENT = new Set([403, 429, 500, 502, 503, 504]);

export async function sendBrevo({ apiKey, from, to, subject, text, baseUrl }) {
  const base = baseUrl || 'https://api.brevo.com/v3';
  const body = JSON.stringify({
    sender: { email: bareAddress(from), name: 'Free API Radar' },
    to: [{ email: bareAddress(to) }],
    subject,
    textContent: text,
  });

  let last = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await request(`${base}/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json' },
      body,
      timeout: 20000,
      retries: 0,
    });

    let detail = res.text.slice(0, 300);
    try {
      const json = JSON.parse(res.text);
      detail = json.messageId ?? json.message ?? json.code ?? detail;
    } catch {
      /* resposta não-JSON */
    }
    last = { provider: 'brevo', ok: res.ok, status: res.status, detail };

    if (res.ok) return { ...last, attempts: attempt };
    if (!TRANSIENT.has(res.status) || attempt === 4) break;
    await sleep(1500 * attempt);
  }
  return last;
}

/** Valida a chave e lista remetentes: o erro clássico é enviar de um e-mail não verificado. */
export async function probeBrevo({ apiKey, baseUrl }) {
  const base = baseUrl || 'https://api.brevo.com/v3';
  const headers = { 'api-key': apiKey, accept: 'application/json' };

  let account = null;
  let senders = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    account = await request(`${base}/account`, { headers, timeout: 15000, retries: 0 });
    senders = await request(`${base}/senders`, { headers, timeout: 15000, retries: 0 }).catch(() => null);
    // Contas novas alternam 403 enquanto a chave propaga: só aceita quando estabiliza.
    if (account.ok && senders?.ok) break;
    if (![403, 429, 500, 502, 503, 504].includes(account.status) || attempt === 3) break;
    await sleep(1500 * attempt);
  }

  let accountInfo = null;
  if (account?.ok) {
    try {
      const json = JSON.parse(account.text);
      accountInfo = {
        email: json.email ?? null,
        company: json.companyName ?? null,
        credits: Array.isArray(json.plan) ? json.plan.map((p) => `${p.type}:${p.credits}`).join(' ') : null,
        message: json.message ?? null,
      };
    } catch {
      /* ignore */
    }
  }

  let senderList = [];
  if (senders?.ok) {
    try {
      senderList = (JSON.parse(senders.text).senders ?? []).map((s) => ({
        email: s.email,
        active: Boolean(s.active),
      }));
    } catch {
      /* ignore */
    }
  }

  // Basta um dos dois para provar que a chave é reconhecida (a API da Brevo oscila).
  const ok = Boolean(account?.ok || senders?.ok);
  return {
    ok,
    status: account?.ok ? account.status : (senders?.status ?? account?.status ?? 0),
    account: accountInfo,
    senders: senderList,
    flaky: Boolean(account && !account.ok && senders?.ok),
  };
}

export async function sendResend({ apiKey, from, to, subject, text, baseUrl }) {
  const base = baseUrl || 'https://api.resend.com';
  const res = await request(`${base}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text }),
    timeout: 20000,
    retries: 0,
  });
  return { provider: 'resend', ok: res.ok, status: res.status, detail: res.text.slice(0, 200) };
}

/** Despacha conforme a configuração; aceita smtp, brevo ou resend. */
export async function sendEmail(cfg, { subject, text }) {
  const to = cfg.to;
  const from = cfg.from || cfg.user || to;
  if (!to) throw new SmtpError('destinatário não configurado (email.to)');

  if (cfg.provider === 'brevo' && cfg.apiKey) return sendBrevo({ ...cfg, from, to, subject, text });
  if (cfg.provider === 'resend' && cfg.apiKey) return sendResend({ ...cfg, from, to, subject, text });
  // O Google mostra a senha de app em blocos ("abcd efgh ijkl mnop"); o SMTP quer sem espaços.
  const host = cfg.host || 'smtp.gmail.com';
  const pass = /gmail/i.test(host) ? String(cfg.pass ?? '').replace(/\s+/g, '') : cfg.pass;

  return sendSmtp({
    host,
    port: Number(cfg.port ?? 465),
    secure: cfg.secure !== false,
    user: cfg.user,
    pass,
    from,
    to,
    subject,
    text,
  });
}

/** Testa só a conexão/EHLO, sem autenticar — útil para diagnosticar rede. */
export async function probeSmtp({ host = 'smtp.gmail.com', port = 465, secure = true, timeout = 12000 }) {
  const socket = await connectSocket({ host, port, secure, timeout });
  const channel = makeChannel(socket);
  const greeting = await channel.read(timeout);
  socket.write(`EHLO freeapi-radar.local${CRLF}`);
  const ehlo = await channel.read(timeout);
  try {
    socket.write(`QUIT${CRLF}`);
  } catch {
    /* ignore */
  }
  socket.destroy();
  return {
    greeting: greeting.trim(),
    capabilities: ehlo
      .split(CRLF)
      .slice(1)
      .map((l) => l.replace(/^\d{3}[ -]/, '').trim())
      .filter(Boolean),
  };
}
