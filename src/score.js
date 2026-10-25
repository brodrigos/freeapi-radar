// Pontuação: o quão útil/confiável é este "caso de API gratuita" para uso real.

const KIND_SCORE = {
  'free-window': 34,
  'permanent-free': 40,
  'free-models': 32,
  'free-tier': 30,
  credits: 16,
  listado: 6,
  divulgação: 4,
  null: 0,
};

const KIND_WEIGHT = {
  'free-window': 6,
  'permanent-free': 6,
  'free-models': 5,
  'free-tier': 4,
  credits: 3,
  listado: 1,
  divulgação: 1,
};

export function pickKind(candidate) {
  const kinds = (candidate.evidence ?? []).map((e) => e.kind).filter(Boolean);
  if (!kinds.length) return null;
  return kinds.sort((a, b) => (KIND_WEIGHT[b] ?? 0) - (KIND_WEIGHT[a] ?? 0))[0];
}

export function scoreCandidate(candidate, verification) {
  const kind = pickKind(candidate);
  const reasons = [];
  let score = KIND_SCORE[kind] ?? 0;
  if (score) reasons.push(`free: ${kind} (+${score})`);

  const api = verification?.api;
  if (api?.status === 200) {
    score += 22;
    reasons.push('endpoint responde 200 (+22)');
  } else if (api?.authRequired) {
    score += 16;
    reasons.push('endpoint compatível, pede chave (+16)');
  } else if (api && api.status) {
    score -= 2;
    reasons.push(`endpoint respondeu ${api.status} (−2)`);
  }

  if (verification?.homepage && !verification.homepage.ok) {
    score -= 8;
    reasons.push('site fora do ar (−8)');
  }

  if (candidate.compat === true) {
    score += 10;
    reasons.push('OpenAI-compatível (+10)');
  } else if (candidate.compat === false) {
    score -= 5;
    reasons.push('não compatível (−5)');
  }

  const modelCount = Math.max(candidate.models?.length ?? 0, api?.modelCount ?? 0);
  if (modelCount) {
    const bonus = Math.min(modelCount, 8);
    score += bonus;
    reasons.push(`${modelCount} modelo(s) gratuito(s) (+${bonus})`);
  }

  const sources = new Set((candidate.evidence ?? []).map((e) => e.source?.split(':')[0]).filter(Boolean));
  const diversity = Math.min(Math.max(sources.size - 1, 0) * 4, 8);
  if (diversity) {
    score += diversity;
    reasons.push(`${sources.size} fontes independentes (+${diversity})`);
  }

  const onlySeed = sources.size === 1 && sources.has('seeds');
  if (onlySeed) {
    score -= 6;
    reasons.push('só conhecimento interno, sem fonte externa (−6)');
  }

  const allText = JSON.stringify(candidate.evidence ?? []).toLowerCase();
  if (/no card|sem cart[ãa]o|without a card/.test(allText)) {
    score += 4;
    reasons.push('sem cartão de crédito (+4)');
  }
  if (/rate limit|quota/.test(allText)) {
    score += 2;
    reasons.push('limites documentados (+2)');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const tier = score >= 78 ? 'A' : score >= 58 ? 'B' : score >= 38 ? 'C' : 'D';
  return { score, tier, kind, reasons };
}
