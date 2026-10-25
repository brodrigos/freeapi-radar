// Smoke test do dashboard: executa o <script> embutido contra um DOM falso,
// para garantir que o HTML gerado não contém JS inválido nem quebra ao renderizar.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const file = process.argv[2] ?? 'reports/dashboard.html';
const html = fs.readFileSync(file, 'utf8');

const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) {
  console.error('✗ nenhum <script> encontrado');
  process.exit(1);
}
if (script.includes('${')) {
  console.error('✗ template literal não resolvido no script do dashboard');
  process.exit(1);
}

const table = {
  html: '',
  set innerHTML(v) {
    this.html = v;
  },
  get innerHTML() {
    return this.html;
  },
  querySelectorAll: () => [],
};

const search = { oninput: null };
let filterClicks = 0;
const buttons = ['all', 'top', 'verified', 'window', 'nokey'].map((f) => ({
  getAttribute: () => f,
  classList: { toggle: () => filterClicks++ },
  get on() {
    return true;
  },
}));

const context = vm.createContext({
  document: {
    getElementById: (id) => (id === 'tb' ? table : id === 'q' ? search : null),
    querySelectorAll: (sel) => (sel.startsWith('button') ? buttons : []),
  },
});

vm.runInContext(script, context);

const checks = [
  ['renderizou linhas', (table.innerHTML.match(/<tr data-i=/g) ?? []).length > 0],
  ['sem "undefined" no HTML', !/>undefined</.test(table.innerHTML)],
  ['link de evidência presente', table.innerHTML.includes('class="ev"')],
  ['filtro "janela grátis" funciona', (() => {
    context.filter = 'window';
    context.render();
    const rows = (table.innerHTML.match(/<tr data-i=/g) ?? []).length;
    const onlyWindow = context.DATA.filter((r) => r.kind === 'free-window').length;
    return rows === onlyWindow;
  })()],
  ['busca filtra', (() => {
    context.filter = 'all';
    context.query = 'openrouter';
    context.render();
    return (table.innerHTML.match(/<tr data-i=/g) ?? []).length >= 1;
  })()],
  ['ordenação por score', (() => {
    context.query = '';
    context.sortKey = 'score';
    context.dir = -1;
    context.render();
    const scores = [...table.innerHTML.matchAll(/class="score t[^"]*">(\d+)/g)].map((m) => Number(m[1]));
    return scores.length > 1 && scores.every((s, i) => i === 0 || scores[i - 1] >= s);
  })()],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed++;
}
process.stdout.write(`\n${failed ? '✗ falhas: ' + failed : '✓ dashboard ok'}\n`);
process.exit(failed ? 1 : 0);
