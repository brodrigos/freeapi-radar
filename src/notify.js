// Notificação de novidades do radar: Telegram, webhook genérico e registro local.
// Config por ambiente ou por config/alerts.json (nunca versionado).

import fs from 'node:fs';
import path from 'node:path';
import { request } from './http.js';
import { sendEmail } from './email.js';

const KIND_PT = {
  'free-window': 'janela grátis',
  'permanent-free': 'free permanente',
  'free-models': 'modelos :free',
  'free-tier': 'free tier',
  credits: 'créditos',
  listado: 'listado',
  divulgação: 'divulgação',
};

export function loadAlertConfig(rootDir) {
  const file = path.join(rootDir, 'config', 'alerts.json');
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* configuração opcional */
  }
  const emailFile = fromFile.email ?? {};
  const emailSecure = process.env.RADAR_EMAIL_SECURE ?? emailFile.secure;
  return {
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN ?? fromFile.telegram?.token ?? null,
      chatId: process.env.TELEGRAM_CHAT_ID ?? fromFile.telegram?.chatId ?? null,
    },
    email: {
      provider: process.env.RADAR_EMAIL_PROVIDER ?? emailFile.provider ?? 'smtp',
      host: process.env.RADAR_EMAIL_HOST ?? emailFile.host ?? 'smtp.gmail.com',
      port: Number(process.env.RADAR_EMAIL_PORT ?? emailFile.port ?? 465),
      secure: String(emailSecure ?? 'true') !== 'false',
      user: process.env.RADAR_EMAIL_USER ?? emailFile.user ?? null,
      pass: process.env.RADAR_EMAIL_PASS ?? emailFile.pass ?? null,
      apiKey: process.env.RADAR_EMAIL_API_KEY ?? emailFile.apiKey ?? null,
      from: process.env.RADAR_EMAIL_FROM ?? emailFile.from ?? null,
      to: process.env.RADAR_EMAIL_TO ?? emailFile.to ?? null,
    },
    webhook: process.env.RADAR_WEBHOOK_URL ?? fromFile.webhook ?? null,
    minScore: Number(process.env.RADAR_ALERT_MIN ?? fromFile.minScore ?? 60),
    dashboardUrl: process.env.RADAR_DASHBOARD_URL ?? fromFile.dashboardUrl ?? 'http://127.0.0.1:8899/',
  };
}

/** O e-mail só entra em ação quando existe um meio de envio configurado. */
export function emailReady(cfg) {
  const e = cfg?.email ?? {};
  if (!e.to) return false;
  if (e.provider === 'brevo' || e.provider === 'resend') return Boolean(e.apiKey);
  return Boolean(e.user && e.pass);
}

/** O que merece alerta: janela grátis, candidato novo bem pontuado, mudança de modelos. */
export function collectFindings(records, diff, { minScore = 60 } = {}) {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const added = new Set(diff?.added ?? []);
  const findings = [];

  for (const r of records) {
    const isNew = added.has(r.key) || !diff || diff.baseline;
    const isWindow = r.freeKind === 'free-window';
    if (isWindow) {
      findings.push({
        priority: 1,
        key: r.key,
        title: `${r.name} — ${KIND_PT[r.freeKind] ?? r.freeKind}`,
        line: `${r.models?.length ? `${r.models.slice(0, 3).join(', ')}` : 'modelos não listados'} · score ${r.score}${r.tier} · ${r.apiBase ?? r.homepage ?? ''}`,
      });
    } else if (isNew && r.score >= minScore) {
      findings.push({
        priority: 2,
        key: r.key,
        title: `${r.name} — novo (${KIND_PT[r.freeKind] ?? r.freeKind ?? '?'})`,
        line: `score ${r.score}${r.tier} · ${r.verification?.summary ?? 'sem verificação'}`,
      });
    }
  }

  for (const ch of diff?.changed ?? []) {
    const r = byKey.get(ch.key);
    findings.push({
      priority: 3,
      key: ch.key,
      title: `${r?.name ?? ch.key} — modelos mudaram`,
      line: `${ch.from} → ${ch.to} modelos gratuitos`,
    });
  }

  return findings.sort((a, b) => a.priority - b.priority);
}

export function formatAlert(findings, meta) {
  const head = `📡 Free API Radar — ${meta.date}`;
  const body = findings.slice(0, 8).map((f) => `• ${f.title}\n  ${f.line}`);
  const tail = `\n${meta.total} candidatos · ${meta.verified} com endpoint verificado`;
  return [head, '', ...body, tail, `\n${meta.dashboardUrl ?? ''}`].join('\n').trim();
}

async function sendTelegram(token, chatId, text) {
  const res = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    timeout: 12000,
    retries: 0,
  });
  return { channel: 'telegram', ok: res.ok, status: res.status, body: res.text.slice(0, 200) };
}

async function sendWebhook(url, payload) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 12000,
    retries: 0,
  });
  return { channel: 'webhook', ok: res.ok, status: res.status, body: res.text.slice(0, 200) };
}

/** Envia o alerta pelos canais configurados e sempre registra em reports/alerts.log. */
export async function dispatchAlert({ rootDir, text, findings, meta, subject }) {
  const cfg = loadAlertConfig(rootDir);
  const results = [];

  if (cfg.telegram.token && cfg.telegram.chatId) {
    results.push(await sendTelegram(cfg.telegram.token, cfg.telegram.chatId, text));
  }
  if (emailReady(cfg)) {
    try {
      const sent = await sendEmail(cfg.email, {
        subject: subject ?? `Free API Radar — ${findings.length} novidade(s) · ${meta.date}`,
        text,
      });
      results.push({ channel: `email:${sent.provider}`, ok: sent.ok, status: sent.status, body: sent.detail });
    } catch (err) {
      results.push({ channel: 'email', ok: false, status: 0, body: err.message });
    }
  }
  if (cfg.webhook) results.push(await sendWebhook(cfg.webhook, { text, findings, meta }));

  fs.mkdirSync(path.join(rootDir, 'reports'), { recursive: true });
  fs.appendFileSync(
    path.join(rootDir, 'reports', 'alerts.log'),
    JSON.stringify({ at: new Date().toISOString(), text, findings, channels: results }) + '\n',
  );

  return { configured: Boolean(cfg.telegram.token || cfg.webhook || emailReady(cfg)), results };
}
