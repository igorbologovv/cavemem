#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expand } from '@cavemem/compress';
import { type Settings, loadSettings, resolveDataDir } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { createEmbedder } from '@cavemem/embedding';
import { type HookName, runHook } from '@cavemem/hooks';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { type EmbedLoopHandle, startEmbedLoop, stateFilePath } from './embed-loop.js';
import { renderIndex, renderSession } from './viewer.js';

const HOOK_NAMES = new Set<HookName>([
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'stop',
  'session-end',
]);

function jsonString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null) return null;
  return JSON.stringify(value);
}

function writeScopeConflictMessage(conflict: {
  task_id: string;
  title: string;
  agent_id: string | null;
  owner_agent_id: string | null;
}): string {
  const agent = conflict.agent_id ?? conflict.owner_agent_id;
  return `active write task ${conflict.task_id}${
    agent ? ` claimed by ${agent}` : ''
  } already owns overlapping scope`;
}

export function buildApp(store: MemoryStore, loop?: EmbedLoopHandle): Hono {
  const app = new Hono();

  app.use('*', async (_c, next) => {
    loop?.touch();
    await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/api/hooks/:name', async (c) => {
    const name = c.req.param('name') as HookName;
    if (!HOOK_NAMES.has(name)) {
      return c.json({ ok: false, ms: 0, error: `unsupported hook: ${name}` }, 400);
    }

    let input: Record<string, unknown>;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ ok: false, ms: 0, error: 'invalid json body' }, 400);
    }

    const existingMetadata =
      typeof input.metadata === 'object' &&
      input.metadata !== null &&
      !Array.isArray(input.metadata)
        ? (input.metadata as Record<string, unknown>)
        : {};

    const metadata: Record<string, unknown> = { ...existingMetadata };

    const agentId = c.req.header('x-cavemem-agent-id');
    const projectId = c.req.header('x-cavemem-project-id');

    if (agentId) metadata.agent_id = agentId;
    if (projectId) metadata.project_id = projectId;

    if (Object.keys(metadata).length > 0) {
      input.metadata = metadata;
    }

    const result = await runHook(name, input as never, { store });
    if (!result.ok) return c.json(result, 500);
    return c.json(result);
  });

  app.post('/api/agents/heartbeat', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const agentId = String(body.agent_id ?? c.req.header('x-cavemem-agent-id') ?? '');
    const projectId = String(body.project_id ?? c.req.header('x-cavemem-project-id') ?? '');

    if (!agentId) return c.json({ error: 'missing agent_id' }, 400);
    if (!projectId) return c.json({ error: 'missing project_id' }, 400);

    return c.json(store.storage.heartbeatAgent({ id: agentId, project_id: projectId }));
  });

  app.get('/api/agents', (c) => {
    const projectId = c.req.query('project_id') ?? c.req.header('x-cavemem-project-id');
    if (!projectId) return c.json({ error: 'missing project_id' }, 400);
    return c.json(store.storage.listAgents(projectId));
  });

  app.post('/api/tasks', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }

    const projectId = String(body.project_id ?? c.req.header('x-cavemem-project-id') ?? '');
    const title = String(body.title ?? '');
    const description = String(body.description ?? '');

    if (!projectId) return c.json({ error: 'missing project_id' }, 400);
    if (!title) return c.json({ error: 'missing title' }, 400);
    if (!description) return c.json({ error: 'missing description' }, 400);

    const mode =
      body.mode === 'parallel_review' || body.mode === 'exclusive' ? body.mode : undefined;

    const kind =
      body.kind === 'review' ||
      body.kind === 'implementation' ||
      body.kind === 'investigation' ||
      body.kind === 'test' ||
      body.kind === 'docs'
        ? body.kind
        : undefined;

    const access = body.access === 'read_only' || body.access === 'write' ? body.access : undefined;

    const createTaskInput: Parameters<typeof store.storage.createTask>[0] = {
      project_id: projectId,
      title,
      description,
      priority: Number(body.priority ?? 0),
      created_by_agent_id:
        typeof body.created_by_agent_id === 'string'
          ? body.created_by_agent_id
          : (c.req.header('x-cavemem-agent-id') ?? null),
    };

    if (typeof body.id === 'string') createTaskInput.id = body.id;
    if (kind !== undefined) createTaskInput.kind = kind;
    if (access !== undefined) createTaskInput.access = access;
    if (mode !== undefined) createTaskInput.mode = mode;
    if (body.max_claims !== undefined) createTaskInput.max_claims = Number(body.max_claims);
    if (body.required_results !== undefined) {
      createTaskInput.required_results = Number(body.required_results);
    }
    if (body.scope !== undefined) createTaskInput.scope = body.scope;

    const task = store.storage.createTask(createTaskInput);

    return c.json(task, 201);
  });

  app.get('/api/tasks', (c) => {
    const projectId = c.req.query('project_id') ?? c.req.header('x-cavemem-project-id');
    if (!projectId) return c.json({ error: 'missing project_id' }, 400);

    const status = c.req.query('status');
    const limit = Number(c.req.query('limit') ?? 100);

    const listOpts: {
      status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
      limit: number;
    } = { limit };

    if (
      status === 'todo' ||
      status === 'in_progress' ||
      status === 'blocked' ||
      status === 'done' ||
      status === 'cancelled'
    ) {
      listOpts.status = status;
    }

    return c.json(store.storage.listTasks(projectId, listOpts));
  });

  app.post('/api/tasks/claim-next', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const agentId = c.req.header('x-cavemem-agent-id') ?? '';
    const projectId = c.req.header('x-cavemem-project-id') ?? '';

    if (!agentId) return c.json({ error: 'missing agent_id' }, 400);
    if (!projectId) return c.json({ error: 'missing project_id' }, 400);

    const task = store.storage.claimNextTask({
      agent_id: agentId,
      project_id: projectId,
      lease_ms: Number(body.lease_ms ?? 10 * 60 * 1000),
    });

    if (!task) return c.json({ task: null });
    return c.json({ task });
  });

  app.post('/api/tasks/:id/claim', async (c) => {
    const id = c.req.param('id');
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const agentId = c.req.header('x-cavemem-agent-id') ?? '';
    const projectId = c.req.header('x-cavemem-project-id') ?? '';
    if (!agentId) return c.json({ error: 'missing agent_id' }, 400);
    if (!projectId) return c.json({ error: 'missing project_id' }, 400);

    const task = store.storage.claimTaskById({
      task_id: id,
      agent_id: agentId,
      project_id: projectId,
      lease_ms: Number(body.lease_ms ?? 10 * 60 * 1000),
    });

    if (!task) {
      const requested = store.storage.getTask(id);
      if (requested?.project_id === projectId && requested.access === 'write') {
        const [conflict] = store.storage.findActiveWriteScopeConflicts({
          project_id: projectId,
          scope: requested.scope,
          exclude_task_id: requested.id,
        });
        if (conflict) {
          return c.json(
            {
              error: writeScopeConflictMessage(conflict),
              conflict,
            },
            409,
          );
        }
      }
      return c.json({ error: 'task is not available to this agent' }, 409);
    }
    return c.json({ task });
  });

  app.patch('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }

    const agentId = c.req.header('x-cavemem-agent-id') ?? '';
    const projectId = c.req.header('x-cavemem-project-id') ?? '';
    if (!agentId) return c.json({ error: 'missing agent_id' }, 400);
    if (!projectId) return c.json({ error: 'missing project_id' }, 400);

    const rawStatus = body.status;
    const status =
      rawStatus === 'todo' ||
      rawStatus === 'in_progress' ||
      rawStatus === 'blocked' ||
      rawStatus === 'done' ||
      rawStatus === 'cancelled'
        ? rawStatus
        : undefined;

    const updateTaskInput: {
      status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
      content?: string | null;
      result?: string | null;
      lease_ms?: number;
      agent_id: string;
      project_id: string;
    } = { agent_id: agentId, project_id: projectId };

    if (status !== undefined) updateTaskInput.status = status;
    updateTaskInput.content = jsonString(body.content ?? body.progress);
    if (body.result !== undefined) updateTaskInput.result = jsonString(body.result);
    if (body.lease_ms !== undefined) updateTaskInput.lease_ms = Number(body.lease_ms);
    const task = store.storage.updateTask(id, updateTaskInput);

    if (!task) return c.json({ error: 'task is not actively claimed by this agent' }, 409);
    return c.json(task);
  });

  app.post('/api/tasks/:id/complete', async (c) => {
    const id = c.req.param('id');

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const agentId = c.req.header('x-cavemem-agent-id') ?? '';
    const projectId = c.req.header('x-cavemem-project-id') ?? '';

    if (!agentId) return c.json({ error: 'missing agent_id' }, 400);
    if (!projectId) return c.json({ error: 'missing project_id' }, 400);

    const task = store.storage.completeTask({
      id,
      agent_id: agentId,
      project_id: projectId,
      result: jsonString(body.result),
    });

    if (!task) return c.json({ error: 'task is not actively claimed by this agent' }, 409);
    return c.json(task);
  });

  app.post('/api/tasks/:id/release', async (c) => {
    const id = c.req.param('id');

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const agentId = c.req.header('x-cavemem-agent-id') ?? '';
    const projectId = c.req.header('x-cavemem-project-id') ?? '';

    if (!agentId) return c.json({ error: 'missing agent_id' }, 400);
    if (!projectId) return c.json({ error: 'missing project_id' }, 400);

    const task = store.storage.releaseTask({
      id,
      agent_id: agentId,
      project_id: projectId,
      reason: jsonString(body.reason),
    });

    if (!task) return c.json({ error: 'task is not actively claimed by this agent' }, 409);
    return c.json(task);
  });

  app.get('/api/tasks/:id/claims', (c) => {
    const id = c.req.param('id');
    return c.json(store.storage.listTaskClaims(id));
  });

  app.get('/api/tasks/:id/events', (c) => {
    const id = c.req.param('id');
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(store.storage.listTaskEvents(id, limit));
  });

  app.get('/api/state', (c) => {
    if (!loop) return c.json({ running: false });
    return c.json({ running: true, ...loop.state() });
  });

  app.get('/api/sessions', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(store.storage.listSessions(limit));
  });

  app.get('/api/sessions/:id/observations', (c) => {
    const id = c.req.param('id');
    const limit = Number(c.req.query('limit') ?? 200);
    const rows = store.timeline(id, undefined, limit);
    return c.json(rows.map((r) => ({ ...r, content: expand(r.content) })));
  });

  app.get('/api/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const limit = Number(c.req.query('limit') ?? 10);
    return c.json(await store.search(q, limit));
  });

  app.get('/api/timeline', (c) => {
    const sessionId = c.req.query('session_id');
    if (!sessionId) return c.json({ error: 'missing session_id' }, 400);

    const aroundRaw = c.req.query('around_id');
    const aroundId = aroundRaw ? Number(aroundRaw) : undefined;
    const limit = Number(c.req.query('limit') ?? 200);

    const rows = store.timeline(sessionId, aroundId, limit);
    const compact = rows.map((r) => ({ id: r.id, kind: r.kind, ts: r.ts }));
    return c.json(compact);
  });

  app.get('/api/observations', (c) => {
    const raw = c.req.query('ids') ?? '';
    const ids = raw
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isInteger(x) && x > 0);

    if (ids.length === 0) return c.json({ error: 'missing ids' }, 400);
    if (ids.length > 50) return c.json({ error: 'too many ids' }, 400);

    const expandRaw = c.req.query('expand');
    const expand = expandRaw === undefined ? true : expandRaw !== 'false';

    const rows = store.getObservations(ids, { expand });
    return c.json(
      rows.map((r) => ({
        id: r.id,
        session_id: r.session_id,
        kind: r.kind,
        ts: r.ts,
        content: r.content,
        metadata: r.metadata,
      })),
    );
  });

  app.get('/', (c) => c.html(renderIndex(store.storage.listSessions(50))));
  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const session = store.storage.getSession(id);
    if (!session) return c.notFound();
    const obs = store.timeline(id, undefined, 500);
    return c.html(
      renderSession(
        session,
        obs.map((r) => ({ ...r, content: expand(r.content) })),
      ),
    );
  });

  return app;
}

function pidFilePath(settings: Settings): string {
  return join(resolveDataDir(settings.dataDir), 'worker.pid');
}

function writePidFile(settings: Settings): void {
  writeFileSync(pidFilePath(settings), String(process.pid));
}

function removePidFile(settings: Settings): void {
  try {
    unlinkSync(pidFilePath(settings));
  } catch {
    // already gone
  }
}

export async function start(): Promise<void> {
  const settings = loadSettings();
  const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
  const store = new MemoryStore({ dbPath, settings });

  writePidFile(settings);

  let loop: EmbedLoopHandle | undefined;
  const servers: Array<ReturnType<typeof serve>> = [];

  const shutdown = async () => {
    removePidFile(settings);
    if (loop) await loop.stop();
    for (const s of servers) s.close();
    store.close();
  };

  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });

  // Build embedder if provider != 'none'. Model load runs in the worker
  // process only — hooks never wait for it.
  let embedder = null;
  try {
    embedder = await createEmbedder(settings, {
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (err) {
    process.stderr.write(
      `[cavemem worker] embedder unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  if (embedder) {
    loop = startEmbedLoop({
      store,
      embedder,
      settings,
      onIdleExit: () => {
        shutdown().finally(() => process.exit(0));
      },
    });
  } else {
    // Still write a minimal state file so `cavemem status` has something to show.
    writeFileSync(
      stateFilePath(settings),
      `${JSON.stringify(
        {
          provider: settings.embedding.provider,
          model: settings.embedding.model,
          dim: 0,
          embedded: 0,
          total: store.storage.countObservations(),
          lastBatchAt: null,
          lastBatchMs: null,
          lastError: null,
          lastHttpAt: Date.now(),
          startedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const app = buildApp(store, loop);
  servers.push(serve({ fetch: app.fetch, port: settings.workerPort, hostname: '127.0.0.1' }));
  process.stderr.write(
    `[cavemem worker] listening on http://127.0.0.1:${settings.workerPort} (pid ${process.pid})\n`,
  );
}

if (isMainEntry()) {
  start().catch((err) => {
    process.stderr.write(`[cavemem worker] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

function isMainEntry(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv).href;
  }
}
