import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let app: Hono;

function seed(): { sessionId: string; a: number; b: number } {
  store.startSession({ id: 's1', ide: 'claude-code', cwd: '/tmp' });
  const a = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'The db config lives at /etc/caveman.conf.',
  });
  const b = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'Please run `pnpm test` now.',
  });
  return { sessionId: 's1', a, b };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-worker-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  app = buildApp(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('worker HTTP', () => {
  it('GET /healthz returns ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /api/sessions returns a session list', async () => {
    seed();
    const res = await app.request('/api/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).toContain('s1');
  });

  it('GET /api/sessions/:id/observations returns expanded text', async () => {
    seed();
    const res = await app.request('/api/sessions/s1/observations');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ content: string }>;
    expect(rows.length).toBeGreaterThan(0);
    // Database abbreviation should be expanded for the viewer.
    expect(rows.some((r) => /database/.test(r.content))).toBe(true);
    // Tech tokens preserved.
    expect(rows.some((r) => r.content.includes('/etc/caveman.conf'))).toBe(true);
  });

  it('GET /api/search returns matching observations', async () => {
    seed();
    const res = await app.request('/api/search?q=config');
    expect(res.status).toBe(200);
    const hits = (await res.json()) as Array<{ id: number; snippet: string }>;
    expect(hits.length).toBeGreaterThan(0);
  });

  it('GET / renders the session index HTML', async () => {
    seed();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('s1');
  });

  it('GET /sessions/:id renders observation HTML', async () => {
    seed();
    const res = await app.request('/sessions/s1');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/etc/caveman.conf');
  });

  it('GET /sessions/:unknown returns 404', async () => {
    const res = await app.request('/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('claims an exact task id instead of higher-priority queued work', async () => {
    store.storage.createTask({
      id: 'high',
      project_id: 'project-a',
      title: 'High priority',
      description: 'Unrelated work',
      priority: 10,
    });
    store.storage.createTask({
      id: 'review/one',
      project_id: 'project-a',
      title: 'Review',
      description: 'Target review',
      mode: 'parallel_review',
      access: 'read_only',
      max_claims: 3,
      required_results: 3,
    });

    const res = await app.request('/api/tasks/review%2Fone/claim', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cavemem-agent-id': 'agent-a',
        'x-cavemem-project-id': 'project-a',
      },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      task: { id: 'review/one', status: 'in_progress' },
    });
    expect(store.storage.getTask('high')?.status).toBe('todo');
  });

  it('rejects exact write claims when another active write task owns the scope', async () => {
    store.storage.createTask({
      id: 'active',
      project_id: 'project-a',
      title: 'Active write',
      description: 'Owns main',
      access: 'write',
      scope: ['src/main.rs'],
    });
    store.storage.createTask({
      id: 'blocked',
      project_id: 'project-a',
      title: 'Blocked write',
      description: 'Overlaps main',
      access: 'write',
      scope: ['src/**'],
    });
    store.storage.claimTaskById({
      task_id: 'active',
      project_id: 'project-a',
      agent_id: 'agent-a',
    });

    const res = await app.request('/api/tasks/blocked/claim', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cavemem-agent-id': 'agent-b',
        'x-cavemem-project-id': 'project-a',
      },
      body: '{}',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('active write task active claimed by agent-a'),
      conflict: { task_id: 'active', agent_id: 'agent-a' },
    });
  });

  it('rejects cross-agent and cross-project task mutations', async () => {
    store.storage.createTask({
      id: 'task-a',
      project_id: 'project-a',
      title: 'Task',
      description: 'Protected task',
    });
    store.storage.claimTaskById({
      task_id: 'task-a',
      project_id: 'project-a',
      agent_id: 'owner',
    });

    const intruderHeaders = {
      'content-type': 'application/json',
      'x-cavemem-agent-id': 'intruder',
      'x-cavemem-project-id': 'project-a',
    };
    const otherProjectHeaders = {
      'content-type': 'application/json',
      'x-cavemem-agent-id': 'owner',
      'x-cavemem-project-id': 'project-b',
    };

    const update = await app.request('/api/tasks/task-a', {
      method: 'PATCH',
      headers: intruderHeaders,
      body: JSON.stringify({ status: 'blocked' }),
    });
    const complete = await app.request('/api/tasks/task-a/complete', {
      method: 'POST',
      headers: otherProjectHeaders,
      body: JSON.stringify({ result: 'not allowed' }),
    });
    const release = await app.request('/api/tasks/task-a/release', {
      method: 'POST',
      headers: intruderHeaders,
      body: '{}',
    });

    expect(update.status).toBe(409);
    expect(complete.status).toBe(409);
    expect(release.status).toBe(409);
    expect(store.storage.getTask('task-a')).toMatchObject({
      status: 'in_progress',
      owner_agent_id: 'owner',
    });
  });
});
