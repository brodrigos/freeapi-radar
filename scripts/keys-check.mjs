/**
 * Raio-x de todas as chaves configuradas no gateway: mostra, por provedor,
 * se o endpoint responde, qual a cota restante e por que algo está bloqueado.
 *
 * Uso: node scripts/keys-check.mjs ["//DS3622xs/docker/litellm-gateway/config.yaml"]
 */
import fs from 'node:fs';

const CFG = process.argv[2] ?? '\\\\DS3622xs\\docker\\litellm-gateway\\config.yaml';

/** Lê o config só pelo que interessa: pares (api_base, api_key) de cada modelo. */
function readProviders(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let cur = null;
  for (const line of lines) {
    if (/^[a-z_]+:/.test(line)) {
      cur = null;
      continue;
    }
    const name = /^\s*-\s*model_name:\s*(.+)$/.exec(line);
    if (name) {
      cur = { name: name[1].trim(), apiBase: null, model: null, apiKey: null };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const model = /^\s+model:\s*(.+)$/.exec(line);
    if (model && !cur.model) cur.model = model[1].trim().replace(/^["']|["']$/g, '');
    const base = /^\s+api_base:\s*(\S+)/.exec(line);
    if (base) cur.apiBase = base[1].replace(/^["']|["']$/g, '');
    const key = /^\s+api_key:\s*(\S+)/.exec(line);
    if (key && !cur.apiKey) cur.apiKey = key[1].replace(/^["']|["']$/g, '');
  }
  return entries;
}

const short = (t, n = 90) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);
const fmt = (n) => (n == null ? '—' : String(n));

// Entradas que usam prefixo nativo do LiteLLM (sem api_base) ganham uma base pública de sondagem.
const NATIVE = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  together_ai: 'https://api.together.xyz/v1',
  cohere: 'https://api.cohere.com/compatibility/v1',
  ollama: 'https://ollama.com/v1',
};

async function probe(base, key) {
  const host = new URL(base).hostname;
  const H = { authorization: `Bearer ${key}`, accept: 'application/json' };

  // OpenRouter tem endpoint próprio de cota.
  if (/openrouter/.test(host)) {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: H });
    if (!r.ok) return { estado: 'erro', detalhe: `HTTP ${r.status}` };
    const d = (await r.json()).data ?? {};
    const f = d.free_model_daily_requests ?? {};
    return {
      estado: f.remaining > 0 ? 'ok' : 'esgotado',
      detalhe: `${f.used}/${f.limit} req hoje · gratis:${d.is_free_tier ? 'sim' : 'não'} · creditos:${d.usage ?? 0}`,
    };
  }

  // Hugging Face: whoami + um request mínimo revela falta de crédito.
  if (/huggingface/.test(host)) {
    const w = await fetch('https://huggingface.co/api/whoami-v2', { headers: H });
    const nome = w.ok ? (await w.json()).name : 'token inválido';
    return { estado: w.ok ? 'ver token' : 'erro', detalhe: `usuário ${nome} · router exige créditos` };
  }

  // Demais: lista de modelos (barata) ou um chat mínimo.
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/models`, { headers: H });
    const t = await r.text();
    if (r.ok) {
      let n = 0;
      try {
        const j = JSON.parse(t);
        n = (j.data ?? j.models ?? []).length;
      } catch {
        /* ignore */
      }
      return { estado: 'ok', detalhe: `${n} modelos visíveis` };
    }
    const msg = short(t, 110);
    if (/bind your alibaba/i.test(msg)) return { estado: 'bloqueado', detalhe: 'exige vincular conta Alibaba Cloud' };
    if (/verified credits|Daily token limit/i.test(msg)) return { estado: 'esgotado', detalhe: msg };
    return { estado: `HTTP ${r.status}`, detalhe: msg };
  } catch (err) {
    return { estado: 'rede', detalhe: err.message };
  }
}

const text = fs.readFileSync(CFG, 'utf8');
const all = readProviders(text);

// Completa a base de quem usa prefixo nativo (ex.: "model: openrouter/...").
for (const e of all) {
  if (e.apiBase || !e.model) continue;
  const prefix = e.model.split('/')[0];
  if (NATIVE[prefix]) e.apiBase = NATIVE[prefix];
}

const entries = all.filter((e) => e.apiBase);

const byBase = new Map();
for (const e of entries) {
  if (!e.apiKey || /^os\.environ/.test(e.apiKey)) continue;
  if (!byBase.has(e.apiBase)) byBase.set(e.apiBase, { key: e.apiKey, aliases: [] });
  byBase.get(e.apiBase).aliases.push(e.name);
}

console.log(`\nconfig: ${CFG}`);
console.log(`provedores com chave no arquivo: ${byBase.size}\n`);
console.log('PROVEDOR'.padEnd(44) + 'ALIASES'.padEnd(22) + 'ESTADO'.padEnd(12) + 'DETALHE');

const rows = [];
for (const [base, info] of byBase) {
  let res;
  try {
    res = await probe(base, info.key);
  } catch (err) {
    res = { estado: 'erro', detalhe: err.message };
  }
  rows.push({ base, ...res, aliases: info.aliases });
  console.log(
    base.replace(/^https?:\/\//, '').padEnd(44) +
      short(info.aliases.join(','), 20).padEnd(22) +
      String(res.estado).padEnd(12) +
      short(res.detalhe, 80),
  );
}

const ok = rows.filter((r) => r.estado === 'ok').length;
console.log(`\nprontos para uso: ${ok}/${rows.length}`);
