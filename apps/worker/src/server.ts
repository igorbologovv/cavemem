#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expand } from '@cavemem/compress';
import { type Settings, loadSettings, resolveDataDir } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { type HookName, runHook } from '@cavemem/hooks';
import { createEmbedder } from '@cavemem/embedding';
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
      typeof input.metadata === 'object' && input.metadata !== null && !Array.isArray(input.metadata)
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
