/**
 * Free API Radar — ferramenta do Brodrigos Dashboard.
 *
 * Só apresenta: os dados vêm de `latest.json`, gravado por `node cli.js scan`
 * nesta mesma pasta. Nenhuma chamada de rede externa acontece aqui.
 */
(function (global) {
  'use strict';

  const B = global.Brodrigos;
  if (!B) return;
  const el = B.el;

  const BASE = String((document.currentScript && document.currentScript.src) || '').replace(/tool\.js(\?.*)?$/, '');

  const KIND_LABEL = {
    'free-window': 'janela grátis',
    'permanent-free': 'free permanente',
    'free-models': 'modelos :free',
    'free-tier': 'free tier',
    credits: 'créditos',
    listado: 'listado',
    divulgação: 'divulgação',
  };

  function statusOf(rec) {
    const api = rec.verification && rec.verification.api;
    if (!api) return { text: 'sem endpoint', cls: 'radar-muted' };
    if (api.status === 200) return { text: `público · ${api.modelCount} modelos`, cls: 'radar-ok' };
    if (api.authRequired) return { text: `chave exigida (${api.status})`, cls: 'radar-keyed' };
    if (api.status === 404) return { text: 'sem listagem /models', cls: 'radar-muted' };
    return { text: `HTTP ${api.status || 'erro'}`, cls: 'radar-bad' };
  }

  function passes(rec, filter, query) {
    const q = query.trim().toLowerCase();
    if (q) {
      const hay = [rec.name, rec.key, rec.apiBase, rec.verification && rec.verification.summary]
        .concat(rec.models || [])
        .join(' ')
        .toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    if (filter === 'top') return rec.tier === 'A' || rec.tier === 'B';
    if (filter === 'verified') {
      const api = rec.verification && rec.verification.api;
      return Boolean(api && (api.status === 200 || api.authRequired));
    }
    if (filter === 'window') return rec.freeKind === 'free-window';
    if (filter === 'nokey') return Boolean(rec.verification && rec.verification.api && rec.verification.api.status === 200);
    return true;
  }

  B.register({
    id: 'freeapi-radar',
    name: 'Free API Radar',
    icon: '📡',
    description: 'Descobre e verifica APIs de LLM com acesso gratuito — free tiers, modelos :free e janelas grátis temporárias.',
    init(body, ctx) {
      const state = { data: null, error: null, filter: 'all', query: '' };

      const root = el('div', { class: 'radar' });
      const stats = el('div', { class: 'radar-stats' });
      const statusLine = el('div', { class: 'radar-status' });
      const chips = el('div', { class: 'radar-bar' });
      const tableWrap = el('div', {});
      root.append(stats, statusLine, chips, tableWrap);
      body.append(root);

      const search = el('input', {
        type: 'search',
        placeholder: 'filtrar por provedor, modelo, endpoint…',
        oninput: (ev) => {
          state.query = ev.target.value;
          render();
        },
      });
      chips.append(search);

      const FILTERS = [
        ['all', 'todos'],
        ['top', 'A/B'],
        ['verified', 'verificados'],
        ['window', 'janela grátis'],
        ['nokey', 'sem chave'],
      ];
      const chipNodes = [];
      FILTERS.forEach(([id, label]) => {
        chipNodes.push(
          el('button', {
            class: 'radar-chip' + (id === 'all' ? ' on' : ''),
            type: 'button',
            text: label,
            dataset: { filter: id },
            onclick: () => {
              state.filter = id;
              chipNodes.forEach((n) => n.classList.toggle('on', n.dataset.filter === id));
              render();
            },
          }),
        );
      });
      chipNodes.forEach((n) => chips.append(n));

      function statCard(value, label, extraClass) {
        return el('div', { class: 'radar-stat' + (extraClass ? ' ' + extraClass : '') }, [
          el('b', { text: String(value) }),
          el('span', { text: label }),
        ]);
      }

      function renderStats(data) {
        const records = (data && data.records) || [];
        const pub = records.filter((r) => r.verification && r.verification.api && r.verification.api.status === 200).length;
        const keyed = records.filter((r) => r.verification && r.verification.api && r.verification.api.authRequired).length;
        const win = records.filter((r) => r.freeKind === 'free-window').length;
        stats.textContent = '';
        stats.append(
          statCard(records.length, 'candidatos'),
          statCard(pub, 'endpoint público'),
          statCard(keyed, 'compatível c/ chave'),
          statCard(win, 'janelas grátis', win ? 'is-window' : ''),
          statCard((data && data.meta && data.meta.elapsed) || 0, 'segundos no scan'),
        );
      }

      function renderTable(data) {
        tableWrap.textContent = '';
        const all = (data && data.records) || [];
        if (!all.length) {
          tableWrap.append(
            el('div', { class: 'radar-empty' }, [
              el('p', { text: 'Sem dados ainda. Rode o scan:' }),
              el('code', { text: 'cd freeapi-radar && node cli.js scan' }),
            ]),
          );
          return;
        }

        const rows = all
          .filter((r) => passes(r, state.filter, state.query))
          .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));

        const table = el('table', { class: 'radar-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'score' }),
              el('th', { text: 'provedor' }),
              el('th', { text: 'tipo' }),
              el('th', { text: 'endpoint' }),
              el('th', { text: 'status' }),
              el('th', { text: 'modelos' }),
            ]),
          ]),
        ]);
        const tbody = el('tbody');
        table.append(tbody);

        for (const rec of rows) {
          const st = statusOf(rec);
          const href = rec.homepage || rec.docsUrl || '#';
          const row = el('tr', { class: 'radar-row' }, [
            el('td', {}, [
              el('span', { class: `radar-score radar-t${rec.tier || 'D'}`, text: String(rec.score) }),
              el('div', { class: 'radar-tier', text: rec.tier || '—' }),
            ]),
            el('td', {}, [
              el('a', { class: 'radar-name', href, target: '_blank', rel: 'noopener', text: rec.name || rec.key }),
              el('div', { class: 'radar-key', text: rec.key }),
            ]),
            el('td', {}, [
              el('span', {
                class: 'radar-pill' + (rec.freeKind === 'free-window' ? ' win' : ''),
                text: KIND_LABEL[rec.freeKind] || rec.freeKind || '—',
              }),
            ]),
            el('td', {}, [
              el('div', { class: 'radar-code', text: rec.apiBase ? rec.apiBase.replace(/^https?:\/\//, '') : '—' }),
              rec.compat ? el('div', { class: 'radar-tier', text: 'OpenAI-compatível' }) : null,
            ]),
            el('td', {}, [
              el('span', { class: st.cls, text: st.text }),
              rec.verification && rec.verification.api && rec.verification.api.elapsedMs
                ? el('div', { class: 'radar-lat', text: `${rec.verification.api.elapsedMs}ms` })
                : null,
            ]),
            el('td', {}, [
              (rec.models || []).length
                ? el(
                    'span',
                    {},
                    (rec.models || []).slice(0, 3).map((m) => el('span', { class: 'radar-model', text: m })),
                  )
                : el('span', { class: 'radar-muted', text: '—' }),
            ]),
          ]);

          const items = (rec.evidence || []).slice(0, 5).map((ev) =>
            el('li', {}, [
              el('span', { text: `“${String(ev.quote || '').slice(0, 220)}” — ` }),
              el('a', { href: ev.url || '#', target: '_blank', rel: 'noopener', text: ev.source || 'fonte' }),
            ]),
          );
          if ((rec.scoreReasons || []).length) {
            items.push(el('li', { text: 'score: ' + rec.scoreReasons.join(' · ') }));
          }

          const detail = el('tr', { class: 'radar-detail' }, [
            el('td', { colspan: '6' }, [el('ul', {}, items)]),
          ]);

          row.addEventListener('click', () => row.classList.toggle('open'));
          tbody.append(row, detail);
        }

        tableWrap.append(table);
        if (!rows.length) {
          tableWrap.append(el('div', { class: 'radar-empty', text: 'Nenhum item com esse filtro.' }));
        }
      }

      function render() {
        const data = state.data;
        renderStats(data);
        renderTable(data);

        const when = (data && data.meta && data.meta.date) || 'nunca';
        const changed = data && data.meta && data.meta.diff;
        const extra = changed && !changed.baseline ? ` · +${changed.added.length} novos, -${changed.removed.length} saíram` : '';
        statusLine.textContent = state.error
          ? `falha ao ler latest.json: ${state.error}`
          : `último scan: ${when}${extra} · ${(data && data.meta && data.meta.runId) || ''}`;
        ctx.setSubtitle(state.error ? 'falha ao ler os dados' : 'APIs de LLM com acesso gratuito');
      }

      async function load() {
        state.error = null;
        try {
          const res = await fetch(`${BASE}latest.json?_=${Date.now()}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          state.data = await res.json();
        } catch (err) {
          state.data = null;
          state.error = err.message;
        }
        render();
      }

      ctx.setFooter(
        el('div', { class: 'actions-row' }, [
          el('button', {
            class: 'btn btn-secondary',
            type: 'button',
            text: 'atualizar',
            onclick: () => {
              load().then(() => ctx.toast('Radar atualizado', 'success'));
            },
          }),
          el('a', {
            class: 'btn btn-ghost',
            href: 'https://github.com/brodrigos/freeapi-radar',
            target: '_blank',
            rel: 'noopener',
            text: 'repositório',
          }),
        ]),
      );

      load();
    },
  });
})(window);
