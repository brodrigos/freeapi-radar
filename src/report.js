// Geração de relatório: Markdown (para ler/commitar) e um dashboard HTML autocontido.

import fs from 'node:fs';
import path from 'node:path';

const KIND_LABEL = {
  'free-window': 'janela grátis (temporária)',
  'permanent-free': 'free tier permanente',
  'free-models': 'modelos :free',
  'free-tier': 'free tier',
  credits: 'créditos iniciais',
  listado: 'apenas listado',
  divulgação: 'divulgação',
};

const statusOf = (r) => {
  const api = r.verification?.api;
  if (!api) return { icon: '·', text: 'sem endpoint conhecido', cls: 'muted' };
  if (api.status === 200) return { icon: '✓', text: `público · ${api.modelCount} modelos`, cls: 'ok' };
  if (api.authRequired) return { icon: '🔑', text: `chave exigida (${api.status})`, cls: 'key' };
  if (api.status === 404) return { icon: '·', text: 'sem listagem /models', cls: 'muted' };
  if (api.status) return { icon: '!', text: `HTTP ${api.status}`, cls: 'warn' };
  return { icon: '✗', text: api.error ? 'sem resposta' : 'falhou', cls: 'bad' };
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function buildMarkdown(records, meta) {
  const verified = records.filter((r) => r.verification?.api?.status === 200 || r.verification?.api?.authRequired);
  const windows = records.filter((r) => r.freeKind === 'free-window');
  const out = [];

  out.push(`# Free API Radar — ${meta.date}`);
  out.push('');
  out.push(
    `**${records.length}** candidatos · **${verified.length}** com endpoint verificado · **${windows.length}** janela(s) grátis ativa(s) · ${meta.elapsed}s`,
  );
  out.push('');

  out.push('## Melhores casos');
  out.push('');
  out.push('| # | Provedor | Tipo de free | Endpoint | Verificação | Score |');
  out.push('|---:|---|---|---|---|---|');
  records.slice(0, 25).forEach((r, i) => {
    const st = statusOf(r);
    out.push(
      `| ${i + 1} | [${r.name}](${r.homepage ?? r.docsUrl ?? '#'}) | ${KIND_LABEL[r.freeKind] ?? r.freeKind ?? '—'} | ${
        r.apiBase ? `\`${r.apiBase.replace(/^https?:\/\//, '')}\`` : '—'
      } | ${st.icon} ${st.text} | **${r.score}** (${r.tier}) |`,
    );
  });
  out.push('');

  out.push('## Detalhes');
  out.push('');
  for (const r of records.slice(0, 15)) {
    const st = statusOf(r);
    out.push(`### ${r.name} — ${r.tier}${r.score}`);
    out.push('');
    if (r.homepage) out.push(`- site: <${r.homepage}>`);
    if (r.docsUrl && r.docsUrl !== r.homepage) out.push(`- chave/docs: <${r.docsUrl}>`);
    if (r.apiBase) out.push(`- endpoint: \`${r.apiBase}\` → ${st.icon} ${st.text}`);
    if (r.compat != null) out.push(`- OpenAI-compatível: ${r.compat ? 'sim' : 'não'}`);
    if (r.models?.length)
      out.push(
        `- modelos gratuitos: ${r.models.slice(0, 8).map((m) => `\`${m}\``).join(', ')}${
          r.models.length > 8 ? ` +${r.models.length - 8}` : ''
        }`,
      );
    for (const e of (r.evidence ?? []).slice(0, 4)) {
      out.push(`- evidência (${e.source}${e.kind ? ` · ${e.kind}` : ''}): “${(e.quote ?? '').slice(0, 180)}” <${e.url}>`);
    }
    if (r.scoreReasons?.length) out.push(`- score: ${r.scoreReasons.join(' · ')}`);
    out.push('');
  }

  if (meta.diff && !meta.diff.baseline) {
    out.push('## Mudanças desde a execução anterior');
    out.push('');
    if (meta.diff.added.length) out.push(`- novos: ${meta.diff.added.map((k) => `\`${k}\``).join(', ')}`);
    if (meta.diff.removed.length) out.push(`- sumiram: ${meta.diff.removed.map((k) => `\`${k}\``).join(', ')}`);
    for (const c of meta.diff.changed) out.push(`- \`${c.key}\`: modelos ${c.from} → ${c.to}`);
    if (!meta.diff.added.length && !meta.diff.removed.length && !meta.diff.changed.length) out.push('- nada mudou');
    out.push('');
  }

  if (meta.notes?.length) {
    out.push('## Notas da execução');
    out.push('');
    for (const n of meta.notes.slice(0, 12)) out.push(`- ${n}`);
    out.push('');
  }

  out.push('---');
  out.push('Gerado por freeapi-radar. Uso pessoal: respeite os termos de cada provedor; não contorne autenticação.');
  return out.join('\n');
}

export function buildHtml(records, meta) {
  const data = records.map((r) => ({
    key: r.key,
    name: r.name,
    homepage: r.homepage,
    docs: r.docsUrl,
    apiBase: r.apiBase,
    kind: r.freeKind,
    kindLabel: KIND_LABEL[r.freeKind] ?? r.freeKind ?? '—',
    models: r.models ?? [],
    score: r.score,
    tier: r.tier,
    compat: r.compat,
    status: statusOf(r),
    summary: r.verification?.summary ?? '',
    latency: r.verification?.api?.elapsedMs ?? null,
    evidence: (r.evidence ?? []).slice(0, 6).map((e) => ({
      quote: String(e.quote ?? '').slice(0, 300),
      url: e.url ?? '',
      source: e.source ?? '',
      kind: e.kind ?? '',
    })),
    reasons: r.scoreReasons ?? [],
  }));

  const okCount = records.filter((r) => r.verification?.api?.status === 200).length;
  const keyCount = records.filter((r) => r.verification?.api?.authRequired).length;
  const winCount = records.filter((r) => r.freeKind === 'free-window').length;

  // Atenção: nada de template literal dentro deste script — o HTML já é um template.
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Free API Radar — ${esc(meta.date)}</title>
<style>
  :root{--bg:#0b0f14;--panel:#111823;--line:#1e2a38;--txt:#d7e2ee;--dim:#7d8ea3;--ok:#3ddc84;--key:#ffc857;--bad:#ff6b6b;--accent:#5aa9ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
  header{padding:26px 28px 10px}
  h1{margin:0 0 6px;font-size:22px;letter-spacing:-.3px}
  .sub{color:var(--dim);font-size:13px}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0 4px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 14px;min-width:112px}
  .stat b{display:block;font-size:19px}
  .stat span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 28px;position:sticky;top:0;background:var(--bg);z-index:5;border-bottom:1px solid var(--line)}
  input[type=search]{flex:1;min-width:200px;background:var(--panel);border:1px solid var(--line);color:var(--txt);padding:9px 12px;border-radius:9px;font-size:13px}
  button{background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:8px 12px;border-radius:9px;cursor:pointer;font-size:12px}
  button.on{color:#04101d;background:var(--accent);border-color:var(--accent);font-weight:600}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  th{position:sticky;top:58px;background:var(--bg);color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;user-select:none}
  tbody tr:hover{background:#0f1620}
  .score{font-weight:700;font-variant-numeric:tabular-nums}
  .tA{color:var(--ok)} .tB{color:#8fd3ff} .tC{color:var(--key)} .tD{color:var(--dim)}
  .pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;border:1px solid var(--line);color:var(--dim)}
  .pill.win{border-color:#6d4d00;color:var(--key);background:#241a00}
  .ok{color:var(--ok)} .key{color:var(--key)} .bad{color:var(--bad)} .warn{color:#ffa06b} .muted{color:var(--dim)}
  code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#a9c7e8;word-break:break-all}
  .ev{margin:0;padding:0;list-style:none;font-size:12px;color:var(--dim)}
  .ev li{margin:2px 0}
  .det{display:none}
  tr.open + tr.det{display:table-row}
  .det td{background:#0d141d;font-size:12px}
  .tier{font-size:10px;color:var(--dim)}
  a{color:var(--accent);text-decoration:none}
  footer{padding:22px 28px;color:var(--dim);font-size:12px}
</style>
</head>
<body>
<header>
  <h1>Free API Radar</h1>
  <div class="sub">Descoberta + verificação ao vivo de APIs de LLM com acesso gratuito · ${esc(meta.date)}</div>
  <div class="stats">
    <div class="stat"><b>${records.length}</b><span>candidatos</span></div>
    <div class="stat"><b>${okCount}</b><span>endpoint público</span></div>
    <div class="stat"><b>${keyCount}</b><span>compatível c/ chave</span></div>
    <div class="stat"><b>${winCount}</b><span>janelas grátis</span></div>
    <div class="stat"><b>${meta.elapsed}s</b><span>duração do scan</span></div>
  </div>
</header>
<div class="bar">
  <input id="q" type="search" placeholder="filtrar por provedor, modelo, domínio…">
  <button data-f="all" class="on">todos</button>
  <button data-f="top">A/B</button>
  <button data-f="verified">verificados</button>
  <button data-f="window">janela grátis</button>
  <button data-f="nokey">sem chave</button>
</div>
<table>
  <thead><tr><th>Score</th><th>Provedor</th><th>Tipo</th><th>Endpoint</th><th>Status</th><th>Modelos</th></tr></thead>
  <tbody id="tb"></tbody>
</table>
<footer>Clique numa linha para ver as evidências. Gerado por <code>freeapi-radar</code> — verificação passiva, sem contornar autenticação.</footer>
<script>
var DATA = ${JSON.stringify(data)};
var tb = document.getElementById('tb');
var filter = 'all', query = '', sortKey = 'score', dir = -1;

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
  });
}

function modelCell(r){
  if (!r.models || !r.models.length) return '<span class="muted">—</span>';
  var head = r.models.slice(0,3).map(function(m){ return '<code>' + esc(m) + '</code>'; }).join(' ');
  var more = r.models.length > 3 ? ' <span class="tier">+' + (r.models.length - 3) + '</span>' : '';
  return head + more;
}

function evidenceCell(r){
  var items = (r.evidence || []).map(function(e){
    return '<li>“' + esc(e.quote) + '” — <a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.source) + '</a>'
      + (e.kind ? ' · ' + esc(e.kind) : '') + '</li>';
  });
  if (r.reasons && r.reasons.length) items.push('<li>score: ' + esc(r.reasons.join(' · ')) + '</li>');
  return '<ul class="ev">' + items.join('') + '</ul>';
}

function rowHtml(r, i){
  var href = r.homepage || r.docs || '#';
  return '<tr data-i="' + i + '">'
    + '<td class="score t' + r.tier + '">' + r.score + '<div class="tier">' + r.tier + '</div></td>'
    + '<td><a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(r.name || r.key) + '</a><div class="tier">' + esc(r.key) + '</div></td>'
    + '<td><span class="pill ' + (r.kind === 'free-window' ? 'win' : '') + '">' + esc(r.kindLabel) + '</span></td>'
    + '<td><code>' + esc((r.apiBase || '—').replace(/^https?:\\/\\//, '')) + '</code>'
    + (r.compat ? '<div class="tier">OpenAI-compatível</div>' : '') + '</td>'
    + '<td class="' + r.status.cls + '">' + r.status.icon + ' ' + esc(r.status.text)
    + (r.latency ? '<div class="tier">' + r.latency + 'ms</div>' : '') + '</td>'
    + '<td>' + modelCell(r) + '</td>'
    + '</tr>'
    + '<tr class="det"><td colspan="6">' + evidenceCell(r) + '</td></tr>';
}

function passes(r){
  var q = query.toLowerCase();
  var hay = [r.name, r.key, r.apiBase, r.summary].concat(r.models || []).join(' ').toLowerCase();
  if (q && hay.indexOf(q) === -1) return false;
  if (filter === 'top') return r.tier === 'A' || r.tier === 'B';
  if (filter === 'verified') return r.status.cls === 'ok' || r.status.cls === 'key';
  if (filter === 'window') return r.kind === 'free-window';
  if (filter === 'nokey') return r.status.cls === 'ok';
  return true;
}

function cmp(a, b){
  var va = sortKey === 'name' ? a.name : sortKey === 'kind' ? a.kindLabel : a.score;
  var vb = sortKey === 'name' ? b.name : sortKey === 'kind' ? b.kindLabel : b.score;
  return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
}

function render(){
  var rows = DATA.filter(passes).sort(cmp);
  tb.innerHTML = rows.map(rowHtml).join('');
  var trs = tb.querySelectorAll('tr[data-i]');
  for (var i = 0; i < trs.length; i++) {
    trs[i].onclick = function(){ this.classList.toggle('open'); };
  }
}

document.getElementById('q').oninput = function(e){ query = e.target.value; render(); };
var btns = document.querySelectorAll('button[data-f]');
for (var b = 0; b < btns.length; b++) {
  btns[b].onclick = function(){
    filter = this.getAttribute('data-f');
    for (var k = 0; k < btns.length; k++) btns[k].classList.toggle('on', btns[k] === this);
    render();
  };
}
var ths = document.querySelectorAll('th');
var keys = ['score','name','kind','apiBase','status','models'];
for (var t = 0; t < ths.length; t++) {
  ths[t].onclick = (function(idx){
    return function(){
      if (sortKey === keys[idx]) dir = dir * -1; else { sortKey = keys[idx]; dir = idx === 0 ? -1 : 1; }
      render();
    };
  })(t);
}
render();
</script>
</body>
</html>`;
}

export function writeReports(outDir, records, meta) {
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, 'radar.md');
  const htmlPath = path.join(outDir, 'dashboard.html');
  fs.writeFileSync(mdPath, buildMarkdown(records, meta), 'utf8');
  fs.writeFileSync(htmlPath, buildHtml(records, meta), 'utf8');
  return { mdPath, htmlPath };
}
