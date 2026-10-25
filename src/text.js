// Normalização de texto/markdown/HTML e classificação do tipo de "free".

/** Host normalizado (sem www) a partir de uma URL. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Chave de deduplicação: domínio registrável aproximado.
 * console.groq.com / api.groq.com -> groq.com ; llm7.io -> llm7.io
 */
export function domainKey(host) {
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoLevel = new Set(['co.uk', 'com.br', 'com.cn', 'co.jp', 'com.au', 'co.in']);
  const last2 = parts.slice(-2).join('.');
  return twoLevel.has(last2) ? parts.slice(-3).join('.') : last2;
}

export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function stripHtml(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text, len = 260) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > len ? `${clean.slice(0, len - 1)}…` : clean;
}

const RE_WINDOW = /free\s+(window|wave)|free models land here|free until|through \w+ \d{1,2}(st|nd|rd|th)?|gratis por tempo|janela gr[áa]tis/i;
const RE_CREDITS = /free credits?|credits? (gratis|gr[áa]tis)|\$\d+ (in )?free|trial credits?/i;
const RE_PERMANENT = /permanent(ly)? free|always free|free forever|free tier with no (card|cost)|sem cart[ãa]o/i;
const RE_TIER = /free tier|free plan|free usage|no card (required|needed)|rate limit(ed)? free|\bgr[áa]tis\b/i;

/**
 * Classifica o tipo de gratuidade de um trecho.
 * Retorna { kind, confidence } ou null quando não há sinal.
 * Ordem importa: janela temporária e créditos são mais específicos que "free tier".
 */
export function classifyFree(text) {
  const t = String(text ?? '');
  if (!t) return null;
  if (RE_WINDOW.test(t)) return { kind: 'free-window', confidence: 0.95 };
  if (RE_CREDITS.test(t)) return { kind: 'credits', confidence: 0.7 };
  if (RE_PERMANENT.test(t)) return { kind: 'permanent-free', confidence: 0.9 };
  if (RE_TIER.test(t)) return { kind: 'free-tier', confidence: 0.6 };
  return null;
}

/** Extrai bases de API OpenAI-compatíveis citadas em um texto. */
export function extractApiBases(text) {
  const found = new Set();
  const re = /https?:\/\/[^\s)"'`<>\]]+/g;
  for (const raw of String(text ?? '').match(re) ?? []) {
    const url = raw.replace(/[.,;:]+$/, '');
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/+$/, '');
      if (!/\/v\d+(\/|$)/.test(path) && !/openai|inference|\/api$/.test(path)) continue;
      found.add(`${u.origin}${path}`);
    } catch {
      /* ignora URL inválida */
    }
  }
  return [...found];
}

/**
 * Parser de listas "awesome": headings `### [Nome](url) bandeira` seguidos de texto livre.
 * Retorna [{ name, url, body }] por seção, agrupado pelo `## ` pai.
 */
export function parseAwesomeSections(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const sections = [];
  let group = null;
  let current = null;

  const push = () => {
    if (current) {
      current.body = current.bodyLines.join(' ').trim();
      sections.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line);
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h2) {
      push();
      group = h2[1].trim();
      continue;
    }
    if (h3) {
      push();
      const raw = h3[1];
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(raw);
      if (!link) continue;
      const flags = raw
        .replace(link[0], ' ')
        .replace(/[|\-–—]/g, ' ')
        .split(/\s+/)
        .filter((tok) => /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(tok));
      current = { name: link[1].trim(), url: link[2].trim(), group, flags, bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  push();
  return sections.filter((s) => s.url && /^https?:/.test(s.url));
}

/** Junta listas preservando a primeira ocorrência. */
export function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
