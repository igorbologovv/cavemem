#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Settings, loadSettings, resolveDataDir } from '@cavemem/config';
import { type Embedder, MemoryStore } from '@cavemem/core';
import { createEmbedder } from '@cavemem/embedding';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

type HttpClient = {
  endpoint: string;
};

function endpointFromEnv(): string | undefined {
  const raw = process.env.CAVEMEM_ENDPOINT?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, '');
}

async function getJson<T>(client: HttpClient, path: string): Promise<T> {
  const response = await fetch(`${client.endpoint}${path}`);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`endpoint ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }

  return JSON.parse(text) as T;
}


async function requestJson<T>(
  client: HttpClient,
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  const agentId = process.env.CAVEMEM_AGENT_ID?.trim();
  const projectId = process.env.CAVEMEM_PROJECT_ID?.trim();

  if (agentId) headers['x-cavemem-agent-id'] = agentId;
  if (projectId) headers['x-cavemem-project-id'] = projectId;

  const response = await fetch(`${client.endpoint}${path}`, {
    method,
    headers,
    body: JSON.stringify(body ?? {}),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`endpoint ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }

  return JSON.parse(text) as T;
}

function envAgentId(): string {
  const value = process.env.CAVEMEM_AGENT_ID?.trim();
  if (!value) throw new Error('CAVEMEM_AGENT_ID is required for coordination tools');
  return value;
}

function envProjectId(): string {
  const value = process.env.CAVEMEM_PROJECT_ID?.trim();
  if (!value) throw new Error('CAVEMEM_PROJECT_ID is required for coordination tools');
  return value;
}


const taskKindSchema = z.enum(['review', 'implementation', 'investigation', 'test', 'docs']);
const taskAccessSchema = z.enum(['read_only', 'write']);
const taskModeSchema = z.enum(['exclusive', 'parallel_review']);
const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);

type TaskKind = z.infer<typeof taskKindSchema>;
type TaskAccess = z.infer<typeof taskAccessSchema>;
type TaskMode = z.infer<typeof taskModeSchema>;
type TaskStatus = z.infer<typeof taskStatusSchema>;

function requireStore(store: MemoryStore | null): MemoryStore {
  if (!store) {
    throw new Error('MemoryStore is unavailable because CAVEMEM_ENDPOINT mode is active');
  }
  return store;
}

/**
 * MCP stdio server exposing progressive-disclosure tools:
 * - search: compact hits with BM25 + optional semantic re-rank
 * - timeline: chronological IDs around a point
 * - get_observations: full bodies by ID
 * - list_sessions: recent sessions for navigation
 *
 * When CAVEMEM_ENDPOINT is set, tools use the common coordinator API instead
 * of opening SQLite directly. This is the multi-agent sandbox mode.
 */
export function buildServer(
  store: MemoryStore | null,
  settings: Settings,
  client?: HttpClient,
): McpServer {
  const server = new McpServer({
    name: 'cavemem',
    version: '0.1.0',
  });

  let embedder: Embedder | null | undefined = undefined;
  const resolveEmbedder = async (): Promise<Embedder | null> => {
    if (client) return null;
    if (embedder !== undefined) return embedder;
    try {
      embedder = await createEmbedder(settings, { log: () => {} });
    } catch (err) {
      process.stderr.write(
        `[cavemem mcp] embedder unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      embedder = null;
    }
    return embedder;
  };

  server.tool(
    'search',
    'Search memory. Returns compact hits — fetch full bodies via get_observations.',
    { query: z.string().min(1), limit: z.number().int().positive().max(50).optional() },
    async ({ query, limit }) => {
      const actualLimit = limit ?? 10;

      const hits = client
        ? await getJson<unknown[]>(
            client,
            `/api/search?q=${encodeURIComponent(query)}&limit=${actualLimit}`,
          )
        : await requireStore(store).search(query, actualLimit, (await resolveEmbedder()) ?? undefined);

      return {
        content: [{ type: 'text', text: JSON.stringify(hits) }],
      };
    },
  );

  server.tool(
    'timeline',
    'Chronological observation IDs for a session. Use to locate context around a point.',
    {
      session_id: z.string().min(1),
      around_id: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ session_id, around_id, limit }) => {
      const actualLimit = limit ?? 200;

      const compact = client
        ? await getJson<unknown[]>(
            client,
            `/api/timeline?session_id=${encodeURIComponent(session_id)}${
              around_id ? `&around_id=${around_id}` : ''
            }&limit=${actualLimit}`,
          )
        : requireStore(store)
            .timeline(session_id, around_id, actualLimit)
            .map((r) => ({ id: r.id, kind: r.kind, ts: r.ts }));

      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    },
  );

  server.tool(
    'get_observations',
    'Fetch full observation bodies by ID. Returns expanded text by default.',
    {
      ids: z.array(z.number().int().positive()).min(1).max(50),
      expand: z.boolean().optional(),
    },
    async ({ ids, expand: expandOpt }) => {
      const expand = expandOpt ?? true;

      const payload = client
        ? await getJson<unknown[]>(
            client,
            `/api/observations?ids=${encodeURIComponent(ids.join(','))}&expand=${expand}`,
          )
        : requireStore(store).getObservations(ids, { expand }).map((r) => ({
            id: r.id,
            session_id: r.session_id,
            kind: r.kind,
            ts: r.ts,
            content: r.content,
            metadata: r.metadata,
          }));

      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  );

  server.tool(
    'list_sessions',
    'List recent sessions in reverse chronological order. Use to navigate before calling timeline.',
    { limit: z.number().int().positive().max(200).optional() },
    async ({ limit }) => {
      const actualLimit = limit ?? 20;

      const sessions = client
        ? await getJson<unknown[]>(client, `/api/sessions?limit=${actualLimit}`)
        : requireStore(store)
            .storage.listSessions(actualLimit)
            .map((s) => ({
              id: s.id,
              ide: s.ide,
              cwd: s.cwd,
              started_at: s.started_at,
              ended_at: s.ended_at,
            }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sessions),
          },
        ],
      };
    },
  );


  server.tool(
    'heartbeat',
    'Mark this agent as alive in the coordinator.',
    {},
    async () => {
      const agent_id = envAgentId();
      const project_id = envProjectId();

      const result = client
        ? await requestJson<unknown>(client, 'POST', '/api/agents/heartbeat', {
            agent_id,
            project_id,
          })
        : requireStore(store).storage.heartbeatAgent({ id: agent_id, project_id });

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'create_task',
    'Create a coordination task. Use mode/access/kind to distinguish review from write work.',
    {
      id: z.string().min(1).optional(),
      title: z.string().min(1),
      description: z.string().min(1),
      kind: taskKindSchema.optional(),
      access: taskAccessSchema.optional(),
      mode: taskModeSchema.optional(),
      max_claims: z.number().int().positive().optional(),
      required_results: z.number().int().positive().optional(),
      priority: z.number().int().optional(),
      scope: z.array(z.string()).optional(),
    },
    async ({ id, title, description, kind, access, mode, max_claims, required_results, priority, scope }) => {
      const project_id = envProjectId();
      const agent_id = process.env.CAVEMEM_AGENT_ID?.trim() || null;

      const body: {
        id?: string;
        project_id: string;
        title: string;
        description: string;
        kind?: TaskKind;
        access?: TaskAccess;
        mode?: TaskMode;
        max_claims?: number;
        required_results?: number;
        priority?: number;
        scope?: string[];
        created_by_agent_id?: string | null;
      } = {
        project_id,
        title,
        description,
        created_by_agent_id: agent_id,
      };

      if (id !== undefined) body.id = id;
      if (kind !== undefined) body.kind = kind;
      if (access !== undefined) body.access = access;
      if (mode !== undefined) body.mode = mode;
      if (max_claims !== undefined) body.max_claims = max_claims;
      if (required_results !== undefined) body.required_results = required_results;
      if (priority !== undefined) body.priority = priority;
      if (scope !== undefined) body.scope = scope;

      const created = client
        ? await requestJson<unknown>(client, 'POST', '/api/tasks', body)
        : requireStore(store).storage.createTask(body);

      return { content: [{ type: 'text', text: JSON.stringify(created) }] };
    },
  );

  server.tool(
    'list_tasks',
    'List coordination tasks for this project.',
    {
      status: taskStatusSchema.optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ status, limit }) => {
      const project_id = envProjectId();
      const actualLimit = limit ?? 100;

      const result = client
        ? await getJson<unknown[]>(
            client,
            `/api/tasks?project_id=${encodeURIComponent(project_id)}&limit=${actualLimit}${
              status ? `&status=${encodeURIComponent(status)}` : ''
            }`,
          )
        : requireStore(store).storage.listTasks(
            project_id,
            status ? { status, limit: actualLimit } : { limit: actualLimit },
          );

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'claim_task',
    'Claim the next available task for this agent. Use before doing project work. Respect task kind/mode/access.',
    {
      lease_ms: z.number().int().positive().optional(),
    },
    async ({ lease_ms }) => {
      const agent_id = envAgentId();
      const project_id = envProjectId();

      const result = client
        ? await requestJson<unknown>(client, 'POST', '/api/tasks/claim-next', {
            ...(lease_ms !== undefined ? { lease_ms } : {}),
          })
        : {
            task: requireStore(store).storage.claimNextTask({
              agent_id,
              project_id,
              ...(lease_ms !== undefined ? { lease_ms } : {}),
            }),
          };

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'update_task',
    'Write progress, block status, or lease extension for a claimed task.',
    {
      id: z.string().min(1),
      status: taskStatusSchema.optional(),
      progress: z.string().optional(),
      result: z.string().optional(),
      lease_ms: z.number().int().positive().optional(),
    },
    async ({ id, status, progress, result, lease_ms }) => {
      const agent_id = envAgentId();
      const project_id = envProjectId();

      const body: {
        status?: TaskStatus;
        progress?: string;
        result?: string;
        lease_ms?: number;
      } = {};

      if (status !== undefined) body.status = status;
      if (progress !== undefined) body.progress = progress;
      if (result !== undefined) body.result = result;
      if (lease_ms !== undefined) body.lease_ms = lease_ms;

      const updated = client
        ? await requestJson<unknown>(client, 'PATCH', `/api/tasks/${encodeURIComponent(id)}`, body)
        : requireStore(store).storage.updateTask(id, {
            ...(status !== undefined ? { status } : {}),
            ...(progress !== undefined ? { content: progress } : {}),
            ...(result !== undefined ? { result } : {}),
            ...(lease_ms !== undefined ? { lease_ms } : {}),
            agent_id,
            project_id,
          });

      return { content: [{ type: 'text', text: JSON.stringify(updated) }] };
    },
  );

  server.tool(
    'complete_task',
    'Submit task result. For parallel_review this stores this agent independent review result.',
    {
      id: z.string().min(1),
      result: z.string().optional(),
    },
    async ({ id, result }) => {
      const agent_id = envAgentId();
      const project_id = envProjectId();

      const completed = client
        ? await requestJson<unknown>(
            client,
            'POST',
            `/api/tasks/${encodeURIComponent(id)}/complete`,
            result !== undefined ? { result } : {},
          )
        : requireStore(store).storage.completeTask({
            id,
            agent_id,
            project_id,
            ...(result !== undefined ? { result } : {}),
          });

      return { content: [{ type: 'text', text: JSON.stringify(completed) }] };
    },
  );


  server.tool(
    'release_task',
    'Release a claimed task without completing it. Use when the task is wrong, blocked, or outside current instructions.',
    {
      id: z.string().min(1),
      reason: z.string().optional(),
    },
    async ({ id, reason }) => {
      const agent_id = envAgentId();
      const project_id = envProjectId();

      const released = client
        ? await requestJson<unknown>(
            client,
            'POST',
            `/api/tasks/${encodeURIComponent(id)}/release`,
            reason !== undefined ? { reason } : {},
          )
        : requireStore(store).storage.releaseTask({
            id,
            agent_id,
            project_id,
            ...(reason !== undefined ? { reason } : {}),
          });

      return { content: [{ type: 'text', text: JSON.stringify(released) }] };
    },
  );

  server.tool(
    'task_claims',
    'List claims/results for a task. Useful for collecting parallel review outputs.',
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const claims = client
        ? await getJson<unknown[]>(client, `/api/tasks/${encodeURIComponent(id)}/claims`)
        : requireStore(store).storage.listTaskClaims(id);

      return { content: [{ type: 'text', text: JSON.stringify(claims) }] };
    },
  );

  server.tool(
    'task_events',
    'List audit events for a task.',
    {
      id: z.string().min(1),
      limit: z.number().int().positive().max(200).optional(),
    },
    async ({ id, limit }) => {
      const actualLimit = limit ?? 100;

      const events = client
        ? await getJson<unknown[]>(
            client,
            `/api/tasks/${encodeURIComponent(id)}/events?limit=${actualLimit}`,
          )
        : requireStore(store).storage.listTaskEvents(id, actualLimit);

      return { content: [{ type: 'text', text: JSON.stringify(events) }] };
    },
  );


  return server;
}

export async function main(): Promise<void> {
  const settings = loadSettings();
  const endpoint = endpointFromEnv();

  const store = endpoint
    ? null
    : new MemoryStore({
        dbPath: join(resolveDataDir(settings.dataDir), 'data.db'),
        settings,
      });

  const server = buildServer(store, settings, endpoint ? { endpoint } : undefined);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainEntry()) {
  main().catch((err) => {
    process.stderr.write(`[cavemem mcp] fatal: ${String(err)}\n`);
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
