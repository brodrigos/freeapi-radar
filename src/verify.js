// Verificação técnica: o candidato existe mesmo? o endpoint responde? exige chave?
// Regra: NADA de contornar autenticação. Só sondagens públicas e, opcionalmente, chaves suas.

import { request, withDeadline } from './http.js';
import { hostOf } from './text.js';

const keysFromEnv = () => {
  try {
    return JSON.parse(process.env.RADAR_KEYS ?? '{}');
  } catch {
    return {};
  }
};

/** HEAD com fallback para GET (vários sites recusam HEAD). */
async function probeHomepage(url, timeout) {
  try {
    const head = await request(url, { method: 'HEAD', timeout, retries: 0 });
    if (head.status === 405 || head.status === 501) throw new Error('HEAD não suportado');
    return { ok: head.ok, status: head.status, elapsedMs: head.elapsedMs };
  } catch {
    try {
      const get = await request(url, { timeout, retries: 0 });
      return { ok: get.ok, status: get.status, elapsedMs: get.elapsedMs };
    } catch (err) {
      return { ok: false, status: 0, error: err.message, elapsedMs: null };
    }
  }
}

async function probeModels(apiBase, apiKey, timeout) {
  const url = `${apiBase.replace(/\/+$/, '')}/models`;
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  try {
    const res = await request(url, { headers, timeout, retries: 0 });
    let models = [];
    if (res.ok) {
      try {
        const json = JSON.parse(res.text);
        models = (json?.data ?? json?.models ?? [])
          .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name ?? m?.model)))
          .filter((m) => typeof m === 'string' && m.length > 0 && m.length < 120);
      } catch {
        /* resposta não-JSON ainda conta como superfície viva */
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      authRequired: res.status === 401 || res.status === 403,
      endpointFound: res.status !== 404 && res.status !== 400,
      modelCount: models.length,
      models: models.slice(0, 12),
      elapsedMs: res.elapsedMs,
      url,
    };
  } catch (err) {
    return { ok: false, status: 0, authRequired: false, endpointFound: false, modelCount: 0, models: [], error: err.message, url };
  }
}

/** Conversa mínima só quando você forneceu uma chave — prova que há inferência de verdade. */
async function probeChat(apiBase, apiKey, model, timeout = 20000) {
  try {
    const res = await request(`${apiBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      timeout,
      retries: 0,
    });
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

export async function verifyCandidate(cand, { timeout = 12000 } = {}) {
  const keys = keysFromEnv();
  const apiKey = keys[cand.key] ?? null;
  const host = cand.homepage ? hostOf(cand.homepage) : null;

  const homepage = cand.homepage ? await probeHomepage(cand.homepage, timeout) : null;
  const api = cand.apiBase ? await probeModels(cand.apiBase, apiKey, timeout) : null;

  let chat = null;
  if (apiKey && api?.ok && api.models.length) {
    chat = await probeChat(cand.apiBase, apiKey, api.models[0]);
  }

  return {
    checkedAt: new Date().toISOString(),
    host,
    homepage,
    api,
    chat,
    ok: Boolean(api?.ok || api?.authRequired || homepage?.ok),
    summary: api
      ? api.status === 200
        ? `endpoint público (${api.modelCount} modelos listados)`
        : api.authRequired
          ? `endpoint OpenAI-compatível, exige chave (HTTP ${api.status})`
          : api.endpointFound
            ? `responde HTTP ${api.status}`
            : `endpoint não encontrado (HTTP ${api.status || 'erro'})`
      : homepage?.ok
        ? 'sem base de API conhecida; site no ar'
        : 'não verificado',
  };
}

export async function verifyAll(candidates, { concurrency = 8, timeout = 10000, verbose = false } = {}) {
  const out = new Map();
  const queue = [...candidates];
  const total = queue.length;
  let done = 0;

  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const cand = queue.shift();
      const result = await withDeadline(verifyCandidate(cand, { timeout }), 20000, {
        checkedAt: new Date().toISOString(),
        host: null,
        homepage: null,
        api: null,
        chat: null,
        ok: false,
        summary: 'verificação excedeu o prazo',
      });
      out.set(cand.key, result);
      done += 1;
      if (verbose) {
        const mark = result.api?.status === 200 ? '✓ público' : result.api?.authRequired ? '🔑 chave' : result.ok ? '~ site' : '✗';
        process.stdout.write(`\r  verificados ${done}/${total}  ${mark} ${cand.key.padEnd(28).slice(0, 28)}`);
      }
    }
  });
  await Promise.all(workers);
  if (verbose) process.stdout.write('\r' + ' '.repeat(70) + '\r');
  return out;
}
