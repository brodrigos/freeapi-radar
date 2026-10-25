// Persistência local (node:sqlite, zero dependências) + histórico para diff entre execuções.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uniqBy } from './text.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  key TEXT PRIMARY KEY,
  name TEXT, homepage TEXT, docs_url TEXT, api_base TEXT,
  compat INTEGER, models TEXT, tags TEXT, evidence TEXT, free_kind TEXT,
  score INTEGER, tier TEXT,
  check_ok INTEGER, check_status INTEGER, check_models INTEGER, auth_required INTEGER,
  latency_ms INTEGER, summary TEXT,
  first_seen TEXT, last_seen TEXT, runs INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT, at TEXT, key TEXT, score INTEGER, free_kind TEXT, models_count INTEGER, check_ok INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, started TEXT, finished TEXT,
  total INTEGER, verified INTEGER, notes TEXT
);
`;

/** Junta candidatos de várias fontes pela chave de domínio. */
export function mergeCandidates(raw) {
  const map = new Map();
  for (const c of raw) {
    if (!c?.key) continue;
    const incoming = { ...c, evidence: [...(c.evidence ?? [])], models: [...(c.models ?? [])], tags: [...(c.tags ?? [])] };
    const cur = map.get(c.key);
    if (!cur) {
      map.set(c.key, incoming);
      continue;
    }
    if ((!cur.name || cur.name === cur.key) && incoming.name) cur.name = incoming.name;
    cur.name = cur.name?.length >= (incoming.name?.length ?? 0) ? cur.name : incoming.name ?? cur.name;
    cur.homepage ??= incoming.homepage;
    cur.docsUrl ??= incoming.docsUrl;
    cur.apiBase ??= incoming.apiBase;
    if (incoming.compat === true) cur.compat = true;
    else if (cur.compat == null) cur.compat = incoming.compat;
    cur.models = [...new Set([...cur.models, ...incoming.models])];
    cur.tags = [...new Set([...cur.tags, ...incoming.tags])];
    cur.evidence.push(...incoming.evidence);
  }
  return [...map.values()].map((c) => ({
    ...c,
    evidence: uniqBy(c.evidence, (e) => `${e.source}|${e.url}|${e.quote?.slice(0, 80)}`),
  }));
}

export function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const upsert = db.prepare(`
    INSERT INTO candidates (key, name, homepage, docs_url, api_base, compat, models, tags, evidence, free_kind,
      score, tier, check_ok, check_status, check_models, auth_required, latency_ms, summary, first_seen, last_seen, runs)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(key) DO UPDATE SET
      name=excluded.name, homepage=excluded.homepage, docs_url=excluded.docs_url, api_base=excluded.api_base,
      compat=excluded.compat, models=excluded.models, tags=excluded.tags, evidence=excluded.evidence,
      free_kind=excluded.free_kind, score=excluded.score, tier=excluded.tier, check_ok=excluded.check_ok,
      check_status=excluded.check_status, check_models=excluded.check_models, auth_required=excluded.auth_required,
      latency_ms=excluded.latency_ms, summary=excluded.summary, last_seen=excluded.last_seen, runs=runs+1
  `);

  return {
    db,
    saveRun(run) {
      db.prepare('INSERT OR REPLACE INTO runs (id, started, finished, total, verified, notes) VALUES (?,?,?,?,?,?)').run(
        run.id,
        run.started,
        run.finished,
        run.total,
        run.verified,
        JSON.stringify(run.notes ?? []),
      );
    },
    saveRecord(rec) {
      upsert.run(
        rec.key,
        rec.name,
        rec.homepage,
        rec.docsUrl,
        rec.apiBase,
        rec.compat == null ? null : rec.compat ? 1 : 0,
        JSON.stringify(rec.models ?? []),
        JSON.stringify(rec.tags ?? []),
        JSON.stringify(rec.evidence ?? []),
        rec.freeKind ?? null,
        rec.score,
        rec.tier,
        rec.verification?.ok ? 1 : 0,
        rec.verification?.api?.status ?? null,
        rec.verification?.api?.modelCount ?? null,
        rec.verification?.api?.authRequired ? 1 : 0,
        rec.verification?.api?.elapsedMs ?? rec.verification?.homepage?.elapsedMs ?? null,
        rec.verification?.summary ?? null,
        rec.firstSeen ?? rec.lastSeen,
        rec.lastSeen,
      );
    },
    snapshot(runId, records) {
      const at = new Date().toISOString();
      const stmt = db.prepare(
        'INSERT INTO snapshots (run_id, at, key, score, free_kind, models_count, check_ok) VALUES (?,?,?,?,?,?,?)',
      );
      for (const r of records) {
        stmt.run(runId, at, r.key, r.score, r.freeKind ?? null, r.models?.length ?? 0, r.verification?.ok ? 1 : 0);
      }
    },
    all() {
      return db
        .prepare('SELECT * FROM candidates ORDER BY score DESC, name ASC')
        .all()
        .map((row) => {
          const verification = {
            checkedAt: row.last_seen,
            ok: Boolean(row.check_ok),
            summary: row.summary,
            api: row.check_status
              ? {
                  status: row.check_status,
                  modelCount: row.check_models ?? 0,
                  authRequired: Boolean(row.auth_required),
                  elapsedMs: row.latency_ms,
                }
              : null,
          };
          return {
            key: row.key,
            name: row.name,
            homepage: row.homepage,
            docsUrl: row.docs_url,
            apiBase: row.api_base,
            compat: row.compat == null ? null : Boolean(row.compat),
            models: JSON.parse(row.models || '[]'),
            tags: JSON.parse(row.tags || '[]'),
            evidence: JSON.parse(row.evidence || '[]'),
            freeKind: row.free_kind,
            score: row.score,
            tier: row.tier,
            verification,
            firstSeen: row.first_seen,
            lastSeen: row.last_seen,
            runs: row.runs,
          };
        });
    },
    diff(runId) {
      const prev = db
        .prepare('SELECT id FROM runs WHERE id != ? ORDER BY finished DESC LIMIT 1')
        .get(runId);
      if (!prev?.id) return { baseline: true, added: [], removed: [], changed: [] };

      const cur = new Map(
        db.prepare('SELECT key, models_count, free_kind FROM snapshots WHERE run_id = ?').all(runId).map((r) => [r.key, r]),
      );
      const old = new Map(
        db
          .prepare('SELECT key, models_count, free_kind FROM snapshots WHERE run_id = ?')
          .all(prev.id)
          .map((r) => [r.key, r]),
      );

      const added = [...cur.keys()].filter((k) => !old.has(k));
      const removed = [...old.keys()].filter((k) => !cur.has(k));
      const changed = [...cur.entries()]
        .filter(([k, v]) => old.has(k) && old.get(k).models_count !== v.models_count)
        .map(([k, v]) => ({ key: k, from: old.get(k).models_count, to: v.models_count }));
      return { baseline: false, previousRun: prev.id, added, removed, changed };
    },
  };
}
