/**
 * Verifica a ferramenta Free API Radar dentro do hub Brodrigos:
 * abre o painel no Chrome headless (via CDP), aciona o modal da ferramenta,
 * confere que a tabela renderizou e salva um screenshot.
 *
 * Uso: node test/verify-dashboard-tool.mjs [url-do-hub]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const HUB = process.argv[2] ?? 'http://127.0.0.1:8899/index.html';
const PORT = 9337;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = resolve(import.meta.dirname, '..', 'reports', 'hub-radar.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(join(tmpdir(), 'radar-cdp-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1280,980',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolvePromise, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolvePromise, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* chrome subindo */
    }
    await sleep(250);
  }
  throw new Error('não achei a página do Chrome');
}

const cleanup = () => {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

try {
  const target = await getTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolvePromise, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolvePromise(msg.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: HUB });
  await sleep(2500);

  const hasTool = await send('Runtime.evaluate', {
    expression: "!!(window.Brodrigos) && Brodrigos.loadTools !== undefined",
    returnByValue: true,
  });
  if (!hasTool.result.value) throw new Error('hub não expôs window.Brodrigos');

  await send('Runtime.evaluate', { expression: "Brodrigos.open('freeapi-radar')", awaitPromise: false });
  await sleep(2500);

  const result = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      rows: document.querySelectorAll('.radar-table tbody tr.radar-row').length,
      chips: document.querySelectorAll('.radar-chip').length,
      stats: document.querySelectorAll('.radar-stat').length,
      score: (document.querySelector('.radar-score') || {}).textContent || null,
      name: (document.querySelector('.radar-name') || {}).textContent || null,
      hasDetail: !!document.querySelector('.radar-detail'),
      status: (document.querySelector('.radar-status') || {}).textContent || null
    })`,
    returnByValue: true,
  });

  const info = JSON.parse(result.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

  const checks = [
    ['modal abriu com estatísticas', info.stats >= 4],
    ['tabela renderizou linhas', info.rows > 0],
    ['filtros presentes', info.chips === 5],
    ['evidência expansível presente', info.hasDetail],
    ['subtítulo com data do scan', Boolean(info.status && info.status.includes('último scan'))],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failed++;
  }
  console.log(`\nlinhas: ${info.rows} · primeiro: ${info.name} (score ${info.score}) · ${info.status}`);
  console.log(`screenshot: ${OUT}`);
  process.exitCode = failed ? 1 : 0;
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  cleanup();
}
