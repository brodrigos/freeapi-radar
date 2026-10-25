#!/usr/bin/env node
// freeapi-radar — descobre, extrai e verifica APIs de LLM com acesso gratuito.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collect, deepProbe } from './src/sources.js';
import { mergeCandidates, openStore } from './src/store.js';
import { verifyAll } from './src/verify.js';
import { pickKind, scoreCandidate } from './src/score.js';
import { writeReports } from './src/report.js';
import { toLiteLLM } from './src/litellm.js';
import { SOURCES } from './src/seeds.js';
import { collectFindings, dispatchAlert, formatAlert, loadAlertConfig } from './src/notify.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(ROOT, 'data', 'radar.sqlite');
const REPORTS = path.join(ROOT, 'reports');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) ?? 'scan';
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

const KIND_PT = {
  'free-window': 'janela grátis',
  'permanent-free': 'free permanente',
  'free-models': 'modelos :free',
  'free-tier': 'free tier',
  credits: 'créditos',
  listado: 'listado',
  divulgação: 'divulgação',
};

const pad = (s, n) => {
  const str = String(s ?? '');
  return str.length >= n ? str.slice(0, n - 1) + '…' : str + ' '.repeat(n - str.length);
};

function printTable(records, limit = 30) {
  console.log(
    c.dim(pad('#', 3) + pad('SCORE', 7) + pad('PROVEDOR', 24) + pad('TIPO', 18) + pad('ENDPOINT', 34) + 'STATUS'),
  );
  records.slice(0, limit).forEach((r, i) => {
    const api = r.verification?.api;
    const status = !api
      ? c.dim('—')
      : api.status === 200
        ? c.green(`✓ público (${api.modelCount})`)
        : api.authRequired
          ? c.yellow(`🔑 chave (${api.status})`)
          : c.red(`✗ ${api.status || 'erro'}`);
    const score = `${r.score}`.padStart(3);
    console.log(
      pad(i + 1, 3) +
        c.bold(pad(score, 7)) +
        pad(r.name ?? r.key, 24) +
        pad(KIND_PT[r.freeKind] ?? r.freeKind ?? '—', 18) +
        pad((r.apiBase ?? '—').replace(/^https?:\/\//, ''), 34) +
        status,
    );
  });
}

async function scan() {
  const started = Date.now();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');

  console.log(c.bold('\n▸ Free API Radar') + c.dim(` — run ${runId}\n`));

  console.log(c.dim('1/4 descoberta'));
  const { candidates: raw, notes } = await collect({ verbose: true });
  let merged = mergeCandidates(raw);
  console.log(c.dim(`      ${merged.length} candidatos únicos de ${raw.length} registros\n`));

  if (!flag('no-probe')) {
    console.log(c.dim('2/4 sondagem de páginas /free, /pricing e llms.txt'));
    const priority = [...merged].sort((a, b) => {
      const rank = (m) =>
        SOURCES.alwaysProbe.includes(m.key) ? 0 : m.apiBase ? 1 : m.tags.includes('lista-curada') ? 2 : 3;
      return rank(a) - rank(b);
    });
    const deep = await deepProbe(priority, {
      limit: Number(opt('probe-limit', SOURCES.probeLimit)),
      verbose: true,
    });

    for (const cand of merged) {
      const hit = deep.get(cand.key);
      if (!hit) continue;
      if (hit.pages?.evidence?.length) cand.evidence.push(...hit.pages.evidence);
      if (!cand.apiBase && hit.pages?.apiBase) cand.apiBase = hit.pages.apiBase;
      if (hit.pages?.models?.length) cand.models = [...new Set([...cand.models, ...hit.pages.models])];
      if (hit.llms?.freeLines?.length) {
        cand.evidence.push({
          source: `llms.txt:${hit.key}`,
          url: `https://${hit.key}/llms.txt`,
          kind: pickKind(cand) ?? 'divulgação',
          quote: hit.llms.freeLines.slice(0, 2).join(' | '),
        });
      }
    }
    console.log('');
  }

  console.log(c.dim('3/4 verificação técnica dos endpoints'));
  const verifications = flag('no-verify') ? new Map() : await verifyAll(merged, { verbose: !flag('quiet') });
  console.log('');

  console.log(c.dim('4/4 pontuação e persistência'));
  const now = new Date().toISOString();
  const store = openStore(DB);
  const existing = new Map(store.all().map((r) => [r.key, r]));

  const records = merged
    .map((cand) => {
      const verification = verifications.get(cand.key) ?? null;
      const { score, tier, kind, reasons } = scoreCandidate(cand, verification);
      return {
        ...cand,
        freeKind: kind,
        score,
        tier,
        scoreReasons: reasons,
        verification,
        firstSeen: existing.get(cand.key)?.firstSeen ?? now,
        lastSeen: now,
      };
    })
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));

  for (const rec of records) store.saveRecord(rec);
  store.saveRun({
    id: runId,
    started: new Date(started).toISOString(),
    finished: new Date().toISOString(),
    total: records.length,
    verified: records.filter((r) => r.verification?.api?.status === 200 || r.verification?.api?.authRequired).length,
    notes: notes.filter((n) => typeof n === 'string'),
  });
  store.snapshot(runId, records);

  const diff = store.diff(runId);
  const elapsed = Math.round((Date.now() - started) / 1000);

  const meta = { date: new Date().toLocaleString('pt-BR'), runId, elapsed, diff, notes: notes.filter((n) => typeof n === 'string') };
  const { mdPath, htmlPath } = writeReports(REPORTS, records, meta);
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const payload = JSON.stringify(
    { meta, records: records.map(({ verification, ...rest }) => ({ ...rest, verification })) },
    null,
    2,
  );
  fs.writeFileSync(path.join(ROOT, 'data', 'latest.json'), payload, 'utf8');

  // O hub do Brodrigos lê esta pasta diretamente (via tools.json).
  const toolData = path.join(ROOT, 'dashboard-tool', 'latest.json');
  fs.mkdirSync(path.dirname(toolData), { recursive: true });
  fs.writeFileSync(toolData, payload, 'utf8');

  console.log('');
  printTable(records, Number(opt('top', 25)));
  console.log('');
  console.log(
    c.dim(`relatório: `) + mdPath + c.dim('  ·  dashboard: ') + htmlPath + c.dim(`  ·  ${elapsed}s`),
  );
  if (!diff.baseline) {
    const bits = [
      diff.added.length ? c.green(`+${diff.added.length} novos`) : null,
      diff.removed.length ? c.red(`-${diff.removed.length} saíram`) : null,
      diff.changed.length ? c.yellow(`~${diff.changed.length} mudaram`) : null,
    ].filter(Boolean);
    console.log(c.dim('diff vs execução anterior: ') + (bits.join(' ') || 'nada mudou'));
  }

  if (flag('notify')) {
    const cfg = loadAlertConfig(ROOT);
    const findings = collectFindings(records, diff, { minScore: Number(opt('alert-min', cfg.minScore)) });
    if (!findings.length) {
      console.log(c.dim('alertas: nada novo acima do limite'));
    } else {
      const text = formatAlert(findings, {
        date: meta.date,
        total: records.length,
        verified: records.filter((r) => r.verification?.api?.status === 200 || r.verification?.api?.authRequired).length,
        dashboardUrl: cfg.dashboardUrl,
      });
      const sent = await dispatchAlert({ rootDir: ROOT, text, findings, meta });
      const channels = sent.results.map((r) => `${r.channel}:${r.ok ? 'ok' : `falhou(${r.status})`}`);
      console.log(
        c.dim(`alertas: ${findings.length} novidade(s) · `) +
          (sent.configured ? channels.join(' ') : c.yellow('nenhum canal configurado (só reports/alerts.log)')),
      );
    }
  }
  console.log('');
}

async function alertTest() {
  const cfg = loadAlertConfig(ROOT);
  const text = `📡 Free API Radar — teste de alerta\n${new Date().toLocaleString('pt-BR')}\n\nSe você recebeu isto, os alertas estão funcionando.`;
  const sent = await dispatchAlert({
    rootDir: ROOT,
    text,
    findings: [{ title: 'teste', line: 'mensagem de teste' }],
    meta: { date: new Date().toLocaleString('pt-BR'), total: 0, verified: 0, dashboardUrl: cfg.dashboardUrl },
  });
  console.log(`telegram: ${cfg.telegram.token && cfg.telegram.chatId ? 'configurado' : c.dim('não configurado')}`);
  console.log(`webhook:  ${cfg.webhook ?? c.dim('não configurado')}`);
  for (const r of sent.results) console.log(`  ${r.channel}: ${r.ok ? c.green('enviado') : c.red(`falhou ${r.status}`)}`);
  console.log(c.dim('registro local: reports/alerts.log'));
}

function list() {
  const store = openStore(DB);
  let records = store.all();
  if (flag('free-only')) records = records.filter((r) => r.freeKind !== 'listado');
  if (flag('verified'))
    records = records.filter((r) => r.verification?.api?.status === 200 || r.verification?.api?.authRequired);
  if (flag('window')) records = records.filter((r) => r.freeKind === 'free-window');
  printTable(records, Number(opt('top', 40)));
}

function report() {
  const store = openStore(DB);
  const records = store.all().map((r) => ({ ...r, scoreReasons: [] }));
  const { mdPath, htmlPath } = writeReports(REPORTS, records, {
    date: new Date().toLocaleString('pt-BR'),
    elapsed: 0,
    notes: [],
  });
  console.log(`regenerado: ${mdPath}\n            ${htmlPath}`);
}

function exportLitellm() {
  const store = openStore(DB);
  const yaml = toLiteLLM(store.all());
  const out = path.join(REPORTS, 'litellm-radar.yaml');
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(out, yaml, 'utf8');
  console.log(yaml);
  console.log(`\n${c.dim('salvo em')} ${out}`);
}

function help() {
  console.log(`
${c.bold('freeapi-radar')} — radar de APIs de LLM com acesso gratuito

  node cli.js scan              descobre, sonda páginas free, verifica e pontua
      --no-probe                pula a sondagem de /free e /pricing
      --no-verify               pula a verificação de endpoints
      --probe-limit N           quantos hosts sondar (padrão 20)
      --notify                  envia alerta das novidades (Telegram/webhook)
      --alert-min N             score mínimo para alertar candidato novo (padrão 60)
      --top N                   linhas no resumo (padrão 25)
  node cli.js list              lista o que já está no banco (--free-only --verified --window --top N)
  node cli.js report            regenera reports/radar.md e reports/dashboard.html
  node cli.js export            gera reports/litellm-radar.yaml (model_list pronto)
  node cli.js diff              compara as duas últimas execuções
  node cli.js alert-test        envia um alerta de teste pelos canais configurados
  node cli.js help

${c.dim('Chaves opcionais para prova de inferência: RADAR_KEYS=\'{"groq.com":"gsk_..."}\' node cli.js scan')}
${c.dim('Canais de alerta: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID ou RADAR_WEBHOOK_URL (ou config/alerts.json)')}
`);
}

function diff() {
  const store = openStore(DB);
  const runs = store.db.prepare('SELECT id, finished, total FROM runs ORDER BY finished DESC LIMIT 2').all();
  if (runs.length < 2) {
    console.log('precisa de pelo menos duas execuções de scan.');
    return;
  }
  const d = store.diff(runs[0].id);
  console.log(c.bold(`\ndiff ${runs[1].id} → ${runs[0].id}\n`));
  if (d.baseline) return console.log('sem baseline.');
  console.log(`novos:   ${d.added.join(', ') || '—'}`);
  console.log(`saíram:  ${d.removed.join(', ') || '—'}`);
  for (const ch of d.changed) console.log(`mudou:   ${ch.key}: ${ch.from} → ${ch.to} modelos`);
  console.log('');
}

try {
  if (cmd === 'scan') await scan();
  else if (cmd === 'list') list();
  else if (cmd === 'report') report();
  else if (cmd === 'export') exportLitellm();
  else if (cmd === 'diff') diff();
  else if (cmd === 'alert-test') await alertTest();
  else help();
} catch (err) {
  console.error(c.red(`\nerro: ${err.message}`));
  if (flag('verbose')) console.error(err);
  process.exit(1);
} finally {
  // Uma resolução de DNS travada mantém o event loop vivo mesmo após abortar o
  // fetch — o trabalho já terminou, então garante a saída (e o flush do stdout).
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
}
