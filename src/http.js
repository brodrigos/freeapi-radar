// Cliente HTTP mínimo, sem dependências: timeout, retry para 429/5xx e pool de concorrência.

export const UA =
  'FreeApiRadar/1.0 (radar pessoal de APIs LLM gratuitas; requisições raras e somente a páginas públicas)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, timeout = 15000, retries = 1, body } = opts;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        body,
        signal: AbortSignal.timeout(timeout),
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
      });
      const text = await res.text();

      // Backoff curto e educado quando o provedor pede calma.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5000) : 1200);
        continue;
      }

      return {
        ok: res.ok,
        status: res.status,
        headers: res.headers,
        text,
        url: res.url || url,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(700);
    }
  }
  throw new Error(`falha ao acessar ${url}: ${lastErr?.message ?? 'erro desconhecido'}`);
}

export const getText = async (url, opts) => (await request(url, opts)).text;

export async function getJson(url, opts) {
  const res = await request(url, opts);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`resposta não-JSON em ${url} (HTTP ${res.status})`);
  }
}

/** Executa fn sobre items com concorrência limitada; preserva a ordem e nunca rejeita. */
export async function pool(items, limit, fn) {  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { __error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Prazo rígido para uma promessa. Necessário porque resolução de DNS travada
 * não respeita AbortSignal do fetch e pode prender o scan por minutos.
 */
export async function withDeadline(promise, ms, fallback) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  promise.catch(() => {}); // evita unhandledRejection se perder a corrida
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}
