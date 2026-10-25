// Coletores de descoberta. Cada fonte devolve candidatos no formato comum.
// Nenhum coletor decide "isto é gratuito" sozinho: todos anexa evidências com citação.

import { getJson, getText, pool, request, withDeadline } from './http.js';
import {
  classifyFree,
  domainKey,
  extractApiBases,
  hostOf,
  parseAwesomeSections,
  truncate,
} from './text.js';
import { BLOCKED_HOSTS, KNOWN_ENDPOINTS, SOURCES } from './seeds.js';

const mkCandidate = (patch = {}) => ({
  key: patch.key ?? null,
  name: patch.name ?? null,
  homepage: patch.homepage ?? null,
  docsUrl: patch.docsUrl ?? null,
  apiBase: patch.apiBase ?? null,
  compat: patch.compat ?? null,
  models: patch.models ?? [],
  evidence: patch.evidence ?? [],
  tags: patch.tags ?? [],
});

function candidateFromUrl(url, extra = {}) {
  const host = hostOf(url);
  if (!host) return null;
  if (BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`))) return null;
  const key = domainKey(host);
  const known = KNOWN_ENDPOINTS[key];
  return mkCandidate({
    key,
    name: extra.name ?? key,
    homepage: `https://${host}`,
    apiBase: known?.apiBase ?? null,
    compat: known?.compat ?? null,
    tags: known ? ['seed'] : [],
    ...extra,
  });
}

/* ---------------------------------------------------------------- OpenRouter */

export async function openrouterFree() {
  const data = await getJson('https://openrouter.ai/api/v1/models', { timeout: 20000 });
  const models = data?.data ?? [];
  const free = models.filter(
    (m) => Number(m?.pricing?.prompt) === 0 && Number(m?.pricing?.completion) === 0,
  );
  if (!free.length) return [];

  return [
    mkCandidate({
      key: 'openrouter.ai',
      name: 'OpenRouter',
      homepage: 'https://openrouter.ai',
      docsUrl: 'https://openrouter.ai/docs',
      apiBase: KNOWN_ENDPOINTS['openrouter.ai'].apiBase,
      compat: true,
      models: free.map((m) => m.id),
      tags: ['gateway', 'api-lista-publica'],
      evidence: [
        {
          source: 'openrouter:models-api',
          url: 'https://openrouter.ai/api/v1/models',
          kind: 'free-models',
          quote: `${free.length} de ${models.length} modelos com pricing zero (verificado no JSON público da API)`,
        },
      ],
    }),
  ];
}

/* ------------------------------------------------------------- Listas curadas */

export async function awesomeList() {
  const [owner, repo] = SOURCES.awesomeRepo.split('/');
  let markdown = null;
  for (const branch of ['main', 'master']) {
    try {
      markdown = await getText(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`,
        { timeout: 20000 },
      );
      if (markdown.length > 500) break;
    } catch {
      markdown = null;
    }
  }
  if (!markdown) return [];

  const sections = parseAwesomeSections(markdown);
  return sections.map((sec) => {
    const key = domainKey(hostOf(sec.url) ?? '') ?? null;
    if (!key) return null;
    const known = KNOWN_ENDPOINTS[key];
    const bases = extractApiBases(sec.body);
    const signal = classifyFree(sec.body) ?? { kind: 'free-tier', confidence: 0.5 };
    return mkCandidate({
      key,
      name: sec.name,
      homepage: `https://${hostOf(sec.url)}`,
      docsUrl: sec.url,
      apiBase: bases[0] ?? known?.apiBase ?? null,
      compat: known?.compat ?? (/not OpenAI|não.*compat/i.test(sec.body) ? false : true),
      tags: [sec.group === 'Inference providers' ? 'inference-provider' : 'provider-api', 'lista-curada'],
      evidence: [
        {
          source: `awesome:${SOURCES.awesomeRepo}`,
          url: `https://github.com/${SOURCES.awesomeRepo}`,
          kind: signal.kind,
          quote: truncate(sec.body || sec.name, 240),
        },
      ],
    });
  }).filter(Boolean);
}

/** Repos curados citados em SOURCES.curatedRepos: só o título/descrição, sem virar provider. */
export async function curatedRepoNotes() {
  const notes = [];
  for (const full of SOURCES.curatedRepos) {
    try {
      const repo = await getJson(`https://api.github.com/repos/${full}`, {
        headers: { accept: 'application/vnd.github+json' },
      });
      notes.push({
        source: 'github:repo',
        name: repo.full_name,
        url: repo.html_url,
        quote: `${repo.description ?? ''} (${repo.stargazers_count}★, atualizado ${repo.pushed_at?.slice(0, 10)})`,
        stars: repo.stargazers_count,
      });
    } catch {
      /* opcional */
    }
  }
  return notes;
}

/* -------------------------------------------------------- Busca no GitHub/HN */

export async function githubSearch(knownKeys = new Set()) {
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const results = [];

  for (const q of SOURCES.githubQueries) {
    try {
      const data = await getJson(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} pushed:>${since}`)}&sort=updated&per_page=8`,
        { headers: { accept: 'application/vnd.github+json' }, timeout: 20000 },
      );
      for (const repo of data?.items ?? []) {
        const host = repo.homepage ? hostOf(repo.homepage) : null;
        results.push({
          source: 'github:search',
          name: repo.full_name,
          url: repo.html_url,
          homepage: repo.homepage ?? null,
          host,
          stars: repo.stargazers_count,
          quote: truncate(repo.description ?? '', 200),
          pushedAt: repo.pushed_at,
        });
      }
    } catch {
      /* limite de taxa do GitHub é esperado; segue o baile */
    }
  }
  // Candidatos "provider" só quando o repo aponta para um domínio próprio já não conhecido.
  const candidates = [];
  for (const r of results) {
    if (!r.host) continue;
    const key = domainKey(r.host);
    if (!key || knownKeys.has(key)) continue;
    candidates.push(
      candidateFromUrl(`https://${r.host}`, {
        name: r.name.split('/')[1] ?? r.name,
        tags: ['github-descoberta'],
        evidence: [
          {
            source: 'github:search',
            url: r.url,
            kind: classifyFree(r.quote)?.kind ?? 'listado',
            quote: r.quote,
          },
        ],
      }),
    );
  }
  return { candidates, references: results };
}

export async function hackernews() {
  const since = Math.floor((Date.now() - 240 * 864e5) / 1000);
  const candidates = [];
  const references = [];

  for (const q of SOURCES.hnQueries) {
    try {
      const data = await getJson(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=8&numericFilters=created_at_i>${since}`,
        { timeout: 20000 },
      );
      for (const hit of data?.hits ?? []) {
        const title = hit.title ?? '';
        if (!/free|gratis|zero.?cost|no.?cost/i.test(title)) continue;
        const url = hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`;
        references.push({ source: 'hn', name: title, url, quote: `${hit.points} pts · ${hit.created_at?.slice(0, 10)}` });
        const host = hostOf(url);
        if (!host || /news\.ycombinator\.com$/.test(host)) continue;
        const cand = candidateFromUrl(url, {
          name: host,
          tags: ['hn'],
          evidence: [
            { source: 'hn', url, kind: classifyFree(title)?.kind ?? 'divulgação', quote: truncate(title, 160) },
          ],
        });
        if (cand) candidates.push(cand);
      }
    } catch {
      /* segue */
    }
  }
  return { candidates, references };
}

/* ------------------------------------------- Sonda de página /free (o "caso") */

const MODEL_ID_RE = /\b([a-z0-9][a-z0-9._-]{1,30})\/([a-z0-9][a-z0-9._:-]{1,60})\b/g;
const BAD_EXT = /\.(svg|png|jpe?g|gif|webp|css|js|ico|woff2?|txt|md)$/i;
// Primeiro segmento que na prática é seção de site, não organização de modelo.
const BAD_ORG = /^(www|cdn|fonts|api|img|assets|blog|docs|doc|login|signup|pricing|agents|connect|company|careers|free|models|legal|terms|privacy|es|pt|fr|de|ja|zh|en|ko)$/i;

/** Extrai ids de modelo e datas de término de uma página de free window. */
export function parseFreePage(html) {
  const text = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const models = new Set();
  for (const [, org, name] of text.matchAll(MODEL_ID_RE)) {
    const id = `${org}/${name}`;
    if (BAD_EXT.test(id) || BAD_ORG.test(org)) continue;
    if (/\.(ai|com|io|cn|xyz|dev|cloud|app|sh|net|org)$/i.test(org)) continue; // é host, não organização
    if (!/\d/.test(name)) continue; // ids de modelo quase sempre carregam versão
    models.add(id);
  }

  const until =
    /\bThrough\s+([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?)/.exec(text)?.[1] ??
    /\b(?:until|até)\s+(\d{1,2}\s+de\s+[a-zç]+\s+de\s+\d{4})/i.exec(text)?.[1] ??
    null;

  const signal = classifyFree(text);
  return { models: [...models].slice(0, 24), until, kind: signal?.kind ?? null };
}

/** Visita /free e /pricing de um host e classifica o que encontra. */
export async function probeFreePages(host) {
  const paths = ['/free', '/pricing'];
  const evidence = [];
  let apiBase = null;
  let models = [];

  for (const path of paths) {
    try {
      const res = await request(`https://${host}${path}`, { timeout: 8000, retries: 0 });
      if (!res.ok) continue;
      const parsed = parseFreePage(res.text);
      const bases = extractApiBases(res.text);
      if (bases[0] && !apiBase) apiBase = bases[0];
      if (parsed.models.length) models = [...new Set([...models, ...parsed.models])];

      const quote = parsed.until
        ? `página ${path}: free window até ${parsed.until}${parsed.models.length ? ` · ${parsed.models.slice(0, 4).join(', ')}` : ''}`
        : `página ${path} existe e menciona acesso gratuito`;
      evidence.push({
        source: `página:${host}${path}`,
        url: `https://${host}${path}`,
        kind: parsed.kind ?? 'free-tier',
        quote,
        models: parsed.models,
      });
      if (parsed.kind) break; // achou o sinal forte, não precisa do /pricing
    } catch {
      /* 404/timeout é normal */
    }
  }
  return { evidence, apiBase, models };
}

/**
 * Descoberta via llms.txt (padrão emergente para agentes).
 * Lê o índice do site, acha linhas ligadas a "free" e segue os links encontrados.
 */
export async function llmsTxt(tldHost) {
  let text;
  try {
    const res = await request(`https://${tldHost}/llms.txt`, { timeout: 8000, retries: 0 });
    if (!res.ok) return null;
    text = res.text;
  } catch {
    return null;
  }
  if (text.length < 50) return null;

  const lines = text.split(/\r?\n/);
  const freeLines = lines.filter((l) => /free|gratis|grátis/i.test(l)).slice(0, 6);
  if (!freeLines.length) return null;

  const links = [];
  for (const line of freeLines) {
    for (const m of line.matchAll(/\((https?:\/\/[^)\s]+)\)/g)) links.push(m[1]);
  }
  return {
    freeLines: freeLines.map((l) => truncate(l.replace(/^[-*\s]+/, ''), 160)),
    freeLinks: [...new Set(links)].slice(0, 3),
  };
}

/* ------------------------------------------------------------ Orquestração */

export async function collect({ verbose = false } = {}) {
  const log = (m) => verbose && console.log(`  · ${m}`);
  const evidence = [];
  const notes = [];
  const candidates = [];

  const take = (label, items) => {
    if (!items?.length) return;
    log(`${label}: ${items.length}`);
    candidates.push(...items);
  };

  const [openrouter, awesome] = await Promise.all([
    openrouterFree().catch((e) => (notes.push(`openrouter: ${e.message}`), [])),
    awesomeList().catch((e) => (notes.push(`awesome: ${e.message}`), [])),
  ]);
  take('openrouter', openrouter);
  take('awesome', awesome);

  const knownKeys = new Set(candidates.map((c) => c.key).filter(Boolean));
  for (const k of Object.keys(KNOWN_ENDPOINTS)) knownKeys.add(k);

  const [gh, hn] = await Promise.all([
    githubSearch(knownKeys).catch((e) => (notes.push(`github: ${e.message}`), { candidates: [], references: [] })),
    hackernews().catch((e) => (notes.push(`hn: ${e.message}`), { candidates: [], references: [] })),
  ]);
  take('github', gh.candidates);
  take('hn', hn.candidates);
  notes.push(...gh.references.slice(0, 20).map((r) => ({ type: 'repo', ...r })));
  notes.push(...hn.references.slice(0, 20).map((r) => ({ type: 'noticia', ...r })));

  // Sementes conhecidas: entram como candidatos para o verificador confirmar.
  const seeds = [];
  for (const [key, cfg] of Object.entries(KNOWN_ENDPOINTS)) {
    seeds.push(
      mkCandidate({
        key,
        name: cfg.label ?? key.split('.')[0],
        homepage: `https://${key}`,
        apiBase: cfg.apiBase,
        compat: cfg.compat,
        tags: ['seed'],
        evidence: [
          { source: 'seeds:conhecimento', url: `https://${key}`, kind: 'free-tier', quote: cfg.note },
        ],
      }),
    );
  }
  take('seeds', seeds);

  evidence.push(...notes.filter((n) => n.url && n.quote).map((n) => ({ note: n })));

  return { candidates, notes };
}

/** Sonda páginas /free, /pricing e /llms.txt dos melhores candidatos descobertos. */
export async function deepProbe(candidates, { limit = SOURCES.llmsTxtProbeLimit, verbose = false } = {}) {
  const targets = candidates
    .filter((c) => c.homepage)
    .filter((c) => !c.evidence?.some((e) => e.kind === 'free-window'))
    .slice(0, limit);

  const results = await pool(targets, 8, async (cand) => {
    const host = hostOf(cand.homepage);
    if (!host) return null;
    const job = (async () => {
      const [pages, llms] = await Promise.all([
        probeFreePages(host).catch(() => null),
        llmsTxt(host).catch(() => null),
      ]);
      return { key: cand.key, pages, llms };
    })();
    const out = await withDeadline(job, 20000, { __error: 'prazo da sondagem estourado' });
    if (verbose && out && !out.__error) {
      const bits = [
        out.pages?.evidence?.length ? `${out.pages.evidence.length} página(s) free` : null,
        out.llms ? 'llms.txt' : null,
      ]
        .filter(Boolean)
        .join(', ');
      if (bits) console.log(`  · ${host}: ${bits}`);
    }
    return out;
  });

  const byKey = new Map();
  for (const r of results) {
    if (!r || r.__error) continue;
    byKey.set(r.key, r);
  }
  return byKey;
}
