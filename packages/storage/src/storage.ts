import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import type {
  AgentRow,
  ClaimTaskInput,
  CreateTaskInput,
  NewObservation,
  NewSummary,
  ObservationRow,
  SearchHit,
  SessionRow,
  SummaryRow,
  TaskClaimRow,
  TaskEventInput,
  TaskEventRow,
  TaskRow,
  TaskStatus,
  UpdateTaskInput,
} from './types.js';

export interface StorageOptions {
  readonly?: boolean;
}

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string, opts: StorageOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, opts.readonly ? { readonly: true } : {});
    this.db.exec(SCHEMA_SQL);
    this.migrateCoordinationSchema();
  }

  private migrateCoordinationSchema(): void {
    const taskColumns = this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{
      name: string;
    }>;
    const names = new Set(taskColumns.map((c) => c.name));

    const addColumn = (name: string, ddl: string) => {
      if (!names.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
    };

    addColumn(
      'kind',
      "kind TEXT NOT NULL DEFAULT 'implementation' CHECK(kind IN ('review','implementation','investigation','test','docs'))",
    );
    addColumn(
      'access',
      "access TEXT NOT NULL DEFAULT 'write' CHECK(access IN ('read_only','write'))",
    );
    addColumn(
      'mode',
      "mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(mode IN ('exclusive','parallel_review'))",
    );
    addColumn('max_claims', 'max_claims INTEGER NOT NULL DEFAULT 1');
    addColumn('required_results', 'required_results INTEGER NOT NULL DEFAULT 1');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_claims (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('claimed','submitted','released','expired')),
        lease_until INTEGER,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(task_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_claims_task ON task_claims(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_claims_agent ON task_claims(agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_claims_project ON task_claims(project_id, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- sessions ---

  createSession(s: Omit<SessionRow, 'ended_at'>): void {
    // INSERT OR IGNORE: SessionStart re-fires on resume/clear/compact with the
    // same session_id, and we want the original row (and ended_at=null) preserved.
    this.db
      .prepare(
        'INSERT OR IGNORE INTO sessions(id, ide, cwd, started_at, metadata) VALUES (?, ?, ?, ?, ?)',
      )
      .run(s.id, s.ide, s.cwd, s.started_at, s.metadata);
  }

  endSession(id: string, ts = Date.now()): void {
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(ts, id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  listSessions(limit = 50): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
      .all(limit) as SessionRow[];
  }

  // --- observations ---

  insertObservation(o: NewObservation): number {
    const ts = o.ts ?? Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO observations(session_id, kind, content, compressed, intensity, ts, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const info = stmt.run(
      o.session_id,
      o.kind,
      o.content,
      o.compressed ? 1 : 0,
      o.intensity,
      ts,
      o.metadata ? JSON.stringify(o.metadata) : null,
    );
    return Number(info.lastInsertRowid);
  }

  getObservations(ids: number[]): ObservationRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`)
      .all(...ids) as ObservationRow[];
  }

  timeline(sessionId: string, aroundId?: number, limit = 50): ObservationRow[] {
    if (aroundId === undefined) {
      return this.db
        .prepare('SELECT * FROM observations WHERE session_id = ? ORDER BY ts DESC LIMIT ?')
        .all(sessionId, limit) as ObservationRow[];
    }
    // Return up to `limit` rows centred on aroundId — two independent,
    // bounded queries merged in JS so neither side can starve the other.
    // A single UNION with a trailing LIMIT would let the "after" half
    // swallow the whole window.
    const half = Math.max(1, Math.floor(limit / 2));
    const before = this.db
      .prepare(
        'SELECT * FROM observations WHERE session_id = ? AND id <= ? ORDER BY id DESC LIMIT ?',
      )
      .all(sessionId, aroundId, half) as ObservationRow[];
    const after = this.db
      .prepare('SELECT * FROM observations WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, aroundId, limit - before.length) as ObservationRow[];
    const seen = new Set<number>();
    const merged: ObservationRow[] = [];
    for (const row of [...before.slice().reverse(), ...after]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    return merged;
  }

  // --- summaries ---

  insertSummary(s: NewSummary): number {
    const ts = s.ts ?? Date.now();
    const info = this.db
      .prepare(
        'INSERT INTO summaries(session_id, scope, content, compressed, intensity, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(s.session_id, s.scope, s.content, s.compressed ? 1 : 0, s.intensity, ts);
    return Number(info.lastInsertRowid);
  }

  listSummaries(sessionId: string): SummaryRow[] {
    return this.db
      .prepare('SELECT * FROM summaries WHERE session_id = ? ORDER BY ts DESC')
      .all(sessionId) as SummaryRow[];
  }

  // --- search (BM25 via FTS5) ---

  /**
   * BM25 search over the observations FTS index. If `cwd` is supplied, results
   * are restricted to observations whose session was opened in that cwd —
   * scoping search to a single project so memory from project A does not leak
   * into project B (see #39).
   */
  searchFts(query: string, limit = 10, cwd?: string | null): SearchHit[] {
    if (!query.trim()) return [];
    const sql = cwd
      ? `SELECT o.id, o.session_id, o.ts,
                snippet(observations_fts, 0, '[', ']', '…', 16) AS snippet,
                bm25(observations_fts) AS score
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         JOIN sessions s ON s.id = o.session_id
         WHERE observations_fts MATCH ? AND s.cwd = ?
         ORDER BY score ASC
         LIMIT ?`
      : `SELECT o.id, o.session_id, o.ts,
                snippet(observations_fts, 0, '[', ']', '…', 16) AS snippet,
                bm25(observations_fts) AS score
         FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid
         WHERE observations_fts MATCH ?
         ORDER BY score ASC
         LIMIT ?`;
    const params = cwd ? [sanitizeMatch(query), cwd, limit] : [sanitizeMatch(query), limit];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      session_id: string;
      ts: number;
      snippet: string;
      score: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      snippet: r.snippet,
      // FTS5 bm25 is "lower is better". Flip sign so higher = better downstream.
      score: -r.score,
      ts: r.ts,
    }));
  }

  // --- coordination ---

  upsertAgent(p: {
    id: string;
    project_id: string;
    status?: 'idle' | 'busy' | 'offline';
    current_task_id?: string | null;
  }): AgentRow {
    const now = Date.now();
    const existing = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(p.id) as
      | AgentRow
      | undefined;

    const status = p.status ?? existing?.status ?? 'idle';
    const currentTaskId =
      p.current_task_id !== undefined ? p.current_task_id : (existing?.current_task_id ?? null);

    this.db
      .prepare(
        `INSERT INTO agents(id, project_id, status, last_seen, current_task_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           status = excluded.status,
           last_seen = excluded.last_seen,
           current_task_id = excluded.current_task_id`,
      )
      .run(p.id, p.project_id, status, now, currentTaskId);

    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(p.id) as AgentRow;
  }

  getActiveTaskForAgent(p: {
    project_id: string;
    agent_id: string;
  }): (TaskRow & { claim_status: string; claim_lease_until: number | null }) | undefined {
    const now = Date.now();

    return this.db
      .prepare(
        `SELECT
           t.*,
           c.status AS claim_status,
           c.lease_until AS claim_lease_until
         FROM task_claims c
         JOIN tasks t ON t.id = c.task_id
         WHERE c.project_id = ?
           AND c.agent_id = ?
           AND c.status = 'claimed'
           AND (c.lease_until IS NULL OR c.lease_until >= ?)
         ORDER BY c.updated_at DESC
         LIMIT 1`,
      )
      .get(p.project_id, p.agent_id, now) as
      | (TaskRow & { claim_status: string; claim_lease_until: number | null })
      | undefined;
  }

  listAgents(projectId: string): AgentRow[] {
    return this.db
      .prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY last_seen DESC')
      .all(projectId) as AgentRow[];
  }

  createTask(p: CreateTaskInput): TaskRow {
    const now = Date.now();
    const id = p.id ?? randomUUID();
    const mode = p.mode ?? 'exclusive';
    const kind = p.kind ?? (mode === 'parallel_review' ? 'review' : 'implementation');
    const access =
      p.access ?? (kind === 'review' || kind === 'investigation' ? 'read_only' : 'write');
    const maxClaims = mode === 'exclusive' ? 1 : Math.max(1, p.max_claims ?? 3);
    const requiredResults =
      mode === 'exclusive' ? 1 : Math.min(maxClaims, Math.max(1, p.required_results ?? maxClaims));
    const priority = p.priority ?? 0;
    const scope = p.scope === undefined ? null : JSON.stringify(p.scope);

    this.db
      .prepare(
        `INSERT INTO tasks(
           id, project_id, title, description, kind, access, status, mode, max_claims, required_results,
           priority, owner_agent_id, lease_until, scope, result, created_by_agent_id,
           created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        p.project_id,
        p.title,
        p.description,
        kind,
        access,
        mode,
        maxClaims,
        requiredResults,
        priority,
        scope,
        p.created_by_agent_id ?? null,
        now,
        now,
      );

    const created = this.getTask(id);
    if (!created) throw new Error(`failed to create task ${id}`);
    return created;
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  listTasks(projectId: string, opts: { status?: TaskStatus; limit?: number } = {}): TaskRow[] {
    const limit = opts.limit ?? 100;
    if (opts.status) {
      return this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE project_id = ? AND status = ?
           ORDER BY priority DESC, created_at ASC
           LIMIT ?`,
        )
        .all(projectId, opts.status, limit) as TaskRow[];
    }

    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE project_id = ?
         ORDER BY
           CASE status
             WHEN 'in_progress' THEN 0
             WHEN 'blocked' THEN 1
             WHEN 'todo' THEN 2
             WHEN 'done' THEN 3
             ELSE 4
           END,
           priority DESC,
           created_at ASC
         LIMIT ?`,
      )
      .all(projectId, limit) as TaskRow[];
  }

  claimNextTask(p: ClaimTaskInput): TaskRow | null {
    const now = Date.now();
    const leaseMs = p.lease_ms ?? 10 * 60 * 1000;
    const leaseUntil = now + leaseMs;

    const tx = this.db.transaction(() => {
      this.expireClaims(p.project_id, now);

      const active = this.db
        .prepare(
          `SELECT t.*
           FROM task_claims c
           JOIN tasks t ON t.id = c.task_id
           WHERE c.project_id = ?
             AND c.agent_id = ?
             AND c.status = 'claimed'
           ORDER BY c.updated_at DESC
           LIMIT 1`,
        )
        .get(p.project_id, p.agent_id) as TaskRow | undefined;

      if (active) {
        this.upsertAgent({
          id: p.agent_id,
          project_id: p.project_id,
          status: 'busy',
          current_task_id: active.id,
        });
        return active;
      }

      const candidate = this.db
        .prepare(
          `SELECT t.*
           FROM tasks t
           WHERE t.project_id = ?
             AND t.status IN ('todo','in_progress')
             AND NOT EXISTS (
               SELECT 1 FROM task_claims mine
               WHERE mine.task_id = t.id
                 AND mine.agent_id = ?
                 AND mine.status IN ('claimed','submitted')
             )
             AND (
               (
                 t.mode = 'exclusive'
                 AND t.status = 'todo'
                 AND NOT EXISTS (
                   SELECT 1 FROM task_claims c
                   WHERE c.task_id = t.id
                     AND c.status = 'claimed'
                 )
               )
               OR
               (
                 t.mode = 'parallel_review'
                 AND (
                   SELECT COUNT(*) FROM task_claims c
                   WHERE c.task_id = t.id
                     AND c.status IN ('claimed','submitted')
                 ) < t.max_claims
               )
             )
           ORDER BY t.priority DESC, t.created_at ASC
           LIMIT 1`,
        )
        .get(p.project_id, p.agent_id) as TaskRow | undefined;

      if (!candidate) {
        this.upsertAgent({
          id: p.agent_id,
          project_id: p.project_id,
          status: 'idle',
          current_task_id: null,
        });
        return null;
      }

      return this.claimSelectedTask(candidate, p.agent_id, leaseUntil, now);
    });

    return tx();
  }

  claimTaskById(p: ClaimTaskInput & { task_id: string }): TaskRow | null {
    const now = Date.now();
    const leaseMs = p.lease_ms ?? 10 * 60 * 1000;
    const leaseUntil = now + leaseMs;

    const tx = this.db.transaction(() => {
      this.expireClaims(p.project_id, now);

      const task = this.db
        .prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?')
        .get(p.task_id, p.project_id) as TaskRow | undefined;
      if (!task || !['todo', 'in_progress'].includes(task.status)) return null;

      const active = this.db
        .prepare(
          `SELECT task_id
           FROM task_claims
           WHERE project_id = ?
             AND agent_id = ?
             AND status = 'claimed'
           LIMIT 1`,
        )
        .get(p.project_id, p.agent_id) as { task_id: string } | undefined;
      if (active) return active.task_id === task.id ? task : null;

      const existingClaim = this.db
        .prepare(
          `SELECT status
           FROM task_claims
           WHERE task_id = ?
             AND project_id = ?
             AND agent_id = ?`,
        )
        .get(task.id, p.project_id, p.agent_id) as { status: string } | undefined;
      if (existingClaim?.status === 'submitted') return null;

      if (task.mode === 'exclusive') {
        const claimed = this.db
          .prepare(
            `SELECT 1
             FROM task_claims
             WHERE task_id = ?
               AND status = 'claimed'
             LIMIT 1`,
          )
          .get(task.id);
        if (task.status !== 'todo' || claimed) return null;
      } else {
        const claims = this.db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM task_claims
             WHERE task_id = ?
               AND status IN ('claimed','submitted')`,
          )
          .get(task.id) as { n: number };
        if (claims.n >= task.max_claims) return null;
      }

      return this.claimSelectedTask(task, p.agent_id, leaseUntil, now);
    });

    return tx();
  }

  updateTask(
    id: string,
    p: UpdateTaskInput & { agent_id: string; project_id: string },
  ): TaskRow | null {
    const existing = this.getTask(id);
    const now = Date.now();
    if (!existing || existing.project_id !== p.project_id) return null;
    if (p.status && !['in_progress', 'blocked'].includes(p.status)) return null;
    if (!this.hasActiveClaim(id, p.project_id, p.agent_id, now)) return null;
    if (existing.mode === 'exclusive' && existing.owner_agent_id !== p.agent_id) return null;

    const status = p.status ?? existing.status;
    const result = p.result !== undefined ? p.result : existing.result;
    const leaseUntil =
      existing.mode === 'exclusive' && p.lease_ms !== undefined
        ? now + p.lease_ms
        : existing.lease_until;

    if (p.lease_ms !== undefined) {
      this.db
        .prepare(
          `UPDATE task_claims
           SET lease_until = ?, updated_at = ?
           WHERE task_id = ?
             AND project_id = ?
             AND agent_id = ?
             AND status = 'claimed'`,
        )
        .run(now + p.lease_ms, now, id, p.project_id, p.agent_id);
    }

    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, result = ?, lease_until = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, result, leaseUntil, now, id);

    if (p.content) {
      this.insertTaskEvent({
        task_id: id,
        project_id: p.project_id,
        agent_id: p.agent_id,
        kind: status === 'blocked' ? 'blocked' : 'progress',
        content: p.content,
      });
    }

    return this.getTask(id) ?? null;
  }

  completeTask(p: {
    id: string;
    project_id: string;
    agent_id: string;
    result?: string | null;
  }): TaskRow | null {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      const task = this.getTask(p.id);
      if (!task || task.project_id !== p.project_id) return null;
      if (task.status !== 'in_progress') return null;
      if (!this.hasActiveClaim(p.id, p.project_id, p.agent_id, now)) return null;
      if (task.mode === 'exclusive' && task.owner_agent_id !== p.agent_id) return null;

      const submittedClaim = this.db
        .prepare(
          `UPDATE task_claims
           SET status = 'submitted',
               result = ?,
               lease_until = NULL,
               updated_at = ?
           WHERE task_id = ?
             AND project_id = ?
             AND agent_id = ?
             AND status = 'claimed'
             AND (lease_until IS NULL OR lease_until >= ?)`,
        )
        .run(p.result ?? null, now, p.id, p.project_id, p.agent_id, now);
      if (submittedClaim.changes !== 1) return null;

      const submitted = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_claims
           WHERE task_id = ?
             AND status = 'submitted'`,
        )
        .get(p.id) as { n: number };

      const effectiveRequiredResults = Math.min(task.required_results, task.max_claims);
      const shouldFinish = task.mode === 'exclusive' || submitted.n >= effectiveRequiredResults;

      if (shouldFinish) {
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'done',
                 result = ?,
                 owner_agent_id = NULL,
                 lease_until = NULL,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(task.mode === 'exclusive' ? (p.result ?? task.result) : task.result, now, p.id);

        if (task.mode === 'parallel_review') {
          const surplusClaims = this.db
            .prepare(
              `SELECT agent_id
               FROM task_claims
               WHERE task_id = ?
                 AND project_id = ?
                 AND status = 'claimed'`,
            )
            .all(p.id, p.project_id) as Array<{ agent_id: string }>;

          this.db
            .prepare(
              `UPDATE task_claims
               SET status = 'released',
                   lease_until = NULL,
                   updated_at = ?
               WHERE task_id = ?
                 AND project_id = ?
                 AND status = 'claimed'`,
            )
            .run(now, p.id, p.project_id);

          for (const claim of surplusClaims) {
            this.insertTaskEvent({
              task_id: p.id,
              project_id: p.project_id,
              agent_id: claim.agent_id,
              kind: 'released',
              content: `review completed after ${submitted.n} submitted results`,
            });
          }
        }
      } else {
        this.db
          .prepare(
            `UPDATE tasks
             SET status = 'in_progress',
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(now, p.id);
      }

      if (shouldFinish) {
        this.db
          .prepare(
            `UPDATE agents
             SET status = 'idle',
                 current_task_id = NULL,
                 last_seen = ?
             WHERE project_id = ?
               AND current_task_id = ?`,
          )
          .run(now, p.project_id, p.id);
      } else {
        this.upsertAgent({
          id: p.agent_id,
          project_id: p.project_id,
          status: 'idle',
          current_task_id: null,
        });
      }

      this.insertTaskEvent({
        task_id: p.id,
        project_id: p.project_id,
        agent_id: p.agent_id,
        kind: 'submitted',
        content: p.result ?? null,
      });

      if (shouldFinish) {
        this.insertTaskEvent({
          task_id: p.id,
          project_id: p.project_id,
          agent_id: p.agent_id,
          kind: 'done',
          content:
            task.mode === 'parallel_review' ? `submitted=${submitted.n}` : (p.result ?? null),
        });
      }

      return this.getTask(p.id) ?? null;
    });

    return tx();
  }

  releaseTask(p: {
    id: string;
    project_id: string;
    agent_id: string;
    reason?: string | null;
  }): TaskRow | null {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      const task = this.getTask(p.id);
      if (!task || task.project_id !== p.project_id) return null;
      if (!this.hasActiveClaim(p.id, p.project_id, p.agent_id, now)) return null;
      if (task.mode === 'exclusive' && task.owner_agent_id !== p.agent_id) return null;

      const releasedClaim = this.db
        .prepare(
          `UPDATE task_claims
           SET status = 'released',
               lease_until = NULL,
               updated_at = ?
           WHERE task_id = ?
             AND project_id = ?
             AND agent_id = ?
             AND status = 'claimed'
             AND (lease_until IS NULL OR lease_until >= ?)`,
        )
        .run(now, p.id, p.project_id, p.agent_id, now);
      if (releasedClaim.changes !== 1) return null;

      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_claims
           WHERE task_id = ?
             AND status IN ('claimed','submitted')`,
        )
        .get(p.id) as { n: number };

      this.db
        .prepare(
          `UPDATE tasks
           SET status = ?,
               owner_agent_id = NULL,
               lease_until = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(active.n > 0 ? 'in_progress' : 'todo', now, p.id);

      this.upsertAgent({
        id: p.agent_id,
        project_id: p.project_id,
        status: 'idle',
        current_task_id: null,
      });

      this.insertTaskEvent({
        task_id: p.id,
        project_id: p.project_id,
        agent_id: p.agent_id,
        kind: 'released',
        content: p.reason ?? null,
      });

      return this.getTask(p.id) ?? null;
    });

    return tx();
  }

  private expireClaims(projectId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE task_claims
         SET status = 'expired', lease_until = NULL, updated_at = ?
         WHERE project_id = ?
           AND status = 'claimed'
           AND lease_until IS NOT NULL
           AND lease_until < ?`,
      )
      .run(now, projectId, now);

    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'todo', owner_agent_id = NULL, lease_until = NULL, updated_at = ?
         WHERE project_id = ?
           AND status = 'in_progress'
           AND NOT EXISTS (
             SELECT 1 FROM task_claims c
             WHERE c.task_id = tasks.id
               AND c.status IN ('claimed','submitted')
           )`,
      )
      .run(now, projectId);
  }

  private hasActiveClaim(taskId: string, projectId: string, agentId: string, now: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM task_claims
           WHERE task_id = ?
             AND project_id = ?
             AND agent_id = ?
             AND status = 'claimed'
             AND (lease_until IS NULL OR lease_until >= ?)
           LIMIT 1`,
        )
        .get(taskId, projectId, agentId, now),
    );
  }

  private claimSelectedTask(
    task: TaskRow,
    agentId: string,
    leaseUntil: number,
    now: number,
  ): TaskRow {
    const existingClaim = this.db
      .prepare(
        `SELECT id FROM task_claims
         WHERE task_id = ?
           AND agent_id = ?
         LIMIT 1`,
      )
      .get(task.id, agentId) as { id: string } | undefined;
    const claimId = existingClaim?.id ?? randomUUID();

    if (existingClaim) {
      this.db
        .prepare(
          `UPDATE task_claims
           SET project_id = ?,
               status = 'claimed',
               lease_until = ?,
               result = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(task.project_id, leaseUntil, now, claimId);
    } else {
      this.db
        .prepare(
          `INSERT INTO task_claims(
             id, task_id, project_id, agent_id, status, lease_until, result, created_at, updated_at
           )
           VALUES (?, ?, ?, ?, 'claimed', ?, NULL, ?, ?)`,
        )
        .run(claimId, task.id, task.project_id, agentId, leaseUntil, now, now);
    }

    if (task.mode === 'exclusive') {
      this.db
        .prepare(
          `UPDATE tasks
           SET status = 'in_progress',
               owner_agent_id = ?,
               lease_until = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(agentId, leaseUntil, now, task.id);
    } else {
      this.db
        .prepare(
          `UPDATE tasks
           SET status = 'in_progress',
               owner_agent_id = NULL,
               lease_until = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(now, task.id);
    }

    this.upsertAgent({
      id: agentId,
      project_id: task.project_id,
      status: 'busy',
      current_task_id: task.id,
    });
    this.insertTaskEvent({
      task_id: task.id,
      project_id: task.project_id,
      agent_id: agentId,
      kind: 'claimed',
      content: `claim_id=${claimId} lease_until=${leaseUntil}`,
    });

    const claimed = this.getTask(task.id);
    if (!claimed) throw new Error(`claimed task ${task.id} disappeared`);
    return claimed;
  }

  heartbeatAgent(p: { id: string; project_id: string }): AgentRow {
    const current = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(p.id) as
      | AgentRow
      | undefined;

    return this.upsertAgent({
      id: p.id,
      project_id: p.project_id,
      status: current?.status ?? 'idle',
      current_task_id: current?.current_task_id ?? null,
    });
  }

  insertTaskEvent(p: TaskEventInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO task_events(task_id, project_id, agent_id, kind, content, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(p.task_id, p.project_id, p.agent_id, p.kind, p.content ?? null, Date.now());

    return Number(info.lastInsertRowid);
  }

  listTaskEvents(taskId: string, limit = 100): TaskEventRow[] {
    return this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY ts ASC LIMIT ?')
      .all(taskId, limit) as TaskEventRow[];
  }

  listTaskClaims(taskId: string): TaskClaimRow[] {
    return this.db
      .prepare('SELECT * FROM task_claims WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as TaskClaimRow[];
  }

  // --- embeddings ---

  putEmbedding(observationId: number, model: string, vec: Float32Array): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO embeddings(observation_id, model, dim, vec) VALUES (?, ?, ?, ?)',
      )
      .run(observationId, model, vec.length, buf);
  }

  getEmbedding(
    observationId: number,
  ): { model: string; dim: number; vec: Float32Array } | undefined {
    const row = this.db
      .prepare('SELECT model, dim, vec FROM embeddings WHERE observation_id = ?')
      .get(observationId) as { model: string; dim: number; vec: Buffer } | undefined;
    if (!row) return undefined;
    const vec = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.dim);
    return { model: row.model, dim: row.dim, vec };
  }

  allEmbeddings(filter?: { model: string; dim: number }): Array<{
    observation_id: number;
    vec: Float32Array;
  }> {
    const rows = filter
      ? (this.db
          .prepare('SELECT observation_id, dim, vec FROM embeddings WHERE model = ? AND dim = ?')
          .all(filter.model, filter.dim) as Array<{
          observation_id: number;
          dim: number;
          vec: Buffer;
        }>)
      : (this.db.prepare('SELECT observation_id, dim, vec FROM embeddings').all() as Array<{
          observation_id: number;
          dim: number;
          vec: Buffer;
        }>);
    return rows.map((r) => ({
      observation_id: r.observation_id,
      // Copy into a fresh buffer — the underlying Buffer from better-sqlite3
      // is freed after the statement is iterated, so aliasing it into a
      // Float32Array is not safe once the row goes out of scope.
      vec: new Float32Array(
        new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength).slice().buffer,
      ),
    }));
  }

  observationsMissingEmbeddings(limit = 100, model?: string): ObservationRow[] {
    if (model) {
      return this.db
        .prepare(
          `SELECT o.* FROM observations o
           LEFT JOIN embeddings e ON e.observation_id = o.id AND e.model = ?
           WHERE e.observation_id IS NULL
           ORDER BY o.id DESC
           LIMIT ?`,
        )
        .all(model, limit) as ObservationRow[];
    }
    return this.db
      .prepare(
        `SELECT o.* FROM observations o
         LEFT JOIN embeddings e ON e.observation_id = o.id
         WHERE e.observation_id IS NULL
         ORDER BY o.id DESC
         LIMIT ?`,
      )
      .all(limit) as ObservationRow[];
  }

  /**
   * Remove embeddings whose model does not match the currently configured one.
   * Returns the number of rows deleted. Used on worker startup when the user
   * has switched embedding models — mixed-model cosine returns garbage.
   */
  dropEmbeddingsWhereModelNot(model: string): number {
    const info = this.db.prepare('DELETE FROM embeddings WHERE model != ?').run(model);
    return Number(info.changes);
  }

  countObservations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number };
    return row.n;
  }

  countEmbeddings(filter?: { model: string; dim: number }): number {
    if (filter) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM embeddings WHERE model = ? AND dim = ?')
        .get(filter.model, filter.dim) as { n: number };
      return row.n;
    }
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number };
    return row.n;
  }

  lastObservationAt(): number | null {
    const row = this.db.prepare('SELECT MAX(ts) AS t FROM observations').get() as {
      t: number | null;
    };
    return row.t ?? null;
  }
}

function sanitizeMatch(q: string): string {
  // Escape double quotes and wrap each bare term to avoid FTS5 syntax errors.
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}
