/**
 * Regras de alerta: o que merece e-mail e o que não merece.
 * Em especial: janela grátis já conhecida NÃO repete alerta a cada scan de 6h.
 *
 * Uso: node test/verify-findings.mjs
 */
import { collectFindings } from '../src/notify.js';

const rec = (key, kind, score) => ({
  key,
  name: key,
  freeKind: kind,
  score,
  tier: 'A',
  models: ['org/modelo-1'],
  apiBase: `https://${key}/v1`,
});

const records = [rec('haimaker.ai', 'free-window', 75), rec('openrouter.ai', 'free-models', 82)];
const hasWindow = (findings, key) => findings.some((f) => f.key === key && f.priority === 1);

const baseline = { baseline: true, added: [], removed: [], changed: [] };
const quiet = { baseline: false, added: [], removed: [], changed: [] };
const freshWindow = { baseline: false, added: ['haimaker.ai'], removed: [], changed: [] };
const movedWindow = { baseline: false, added: [], removed: [], changed: [{ key: 'haimaker.ai', from: 2, to: 3 }] };

const cases = [
  ['1ª execução: janela entra', hasWindow(collectFindings(records, baseline), 'haimaker.ai')],
  ['1ª execução: candidato novo de score alto entra', collectFindings(records, baseline).some((f) => f.key === 'openrouter.ai')],
  ['scan seguinte sem novidade: silêncio total', collectFindings(records, quiet).length === 0],
  ['janela nova: alerta', hasWindow(collectFindings(records, freshWindow), 'haimaker.ai')],
  ['janela que mudou: alerta', hasWindow(collectFindings(records, movedWindow), 'haimaker.ai')],
  ['mudança de modelos vira achado próprio', collectFindings(records, movedWindow).some((f) => f.priority === 3)],
  [
    'score abaixo do limite não alerta',
    collectFindings([rec('baixo.com', 'free-tier', 20)], baseline).length === 0,
  ],
];

let failed = 0;
for (const [label, ok] of cases) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} falha(s)` : '\n7/7 ok');
process.exit(failed ? 1 : 0);
