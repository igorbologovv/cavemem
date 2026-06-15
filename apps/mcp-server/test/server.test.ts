import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore | null;
let client: Client;

async function connectServer(server: ReturnType<typeof buildServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const nextClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), nextClient.connect(clientTransport)]);
  return nextClient;
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
}

async function seed(): Promise<{ a: number; b: number }> {
  if (!store) throw new Error('local store is not initialized');
  store.startSession({ id: 's1', ide: 'test', cwd: '/tmp' });
  const a = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'The db config lives at /etc/caveman.conf.',
  });
  const b = store.addObservation({
    session_id: 's1',
    kind: 'note',
    content: 'Please just run `cargo build --release` tomorrow.',
  });
  return { a, b };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-mcp-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  client = await connectServer(server);
});

afterEach(async () => {
  await client.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('MCP server', () => {
  it('lists the cavemem tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'claim_task',
      'complete_task',
      'create_task',
      'get_observations',
      'heartbeat',
      'list_sessions',
      'list_tasks',
      'release_task',
      'search',
      'task_claims',
      'task_events',
      'timeline',
      'update_task',
    ]);
  });

  it('search returns compact hits (id, snippet, score, ts)', async () => {
    await seed();
    const res = await client.callTool({ name: 'search', arguments: { query: 'cargo' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const hits = JSON.parse(text) as Array<{ id: number; snippet: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h).toHaveProperty('id');
      expect(h).toHaveProperty('snippet');
      expect(h).toHaveProperty('score');
      // No full body leaks into the compact shape.
      expect(Object.keys(h).sort()).toEqual(['id', 'score', 'session_id', 'snippet', 'ts']);
    }
  });

  it('timeline returns id/kind/ts only (progressive disclosure)', async () => {
    await seed();
    const res = await client.callTool({ name: 'timeline', arguments: { session_id: 's1' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'ts']);
    }
  });

  it('get_observations returns expanded text by default and preserves tech tokens', async () => {
    const { a } = await seed();
    const res = await client.callTool({ name: 'get_observations', arguments: { ids: [a] } });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ id: number; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain('/etc/caveman.conf');
    expect(rows[0]?.content).toMatch(/database/);
  });

  it('get_observations with expand=false returns the compressed stored form', async () => {
    const { b } = await seed();
    const res = await client.callTool({
      name: 'get_observations',
      arguments: { ids: [b], expand: false },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '[]';
    const rows = JSON.parse(text) as Array<{ content: string }>;
    // Compression drops "Please just" but keeps the command intact.
    expect(rows[0]?.content).not.toMatch(/Please just/);
    expect(rows[0]?.content).toContain('`cargo build --release`');
  });

  it('get_observations reports an error on invalid input (empty ids)', async () => {
    const res = await client.callTool({
      name: 'get_observations',
      arguments: { ids: [] },
    });
    expect(res.isError).toBe(true);
  });
});

describe('MCP endpoint mode', () => {
  beforeEach(async () => {
    await client.close();
    store?.close();
    store = null;
    client = await connectServer(
      buildServer(null, defaultSettings, { endpoint: 'https://coordinator.test' }),
    );
  });

  it('routes memory tools to the coordinator with encoded query parameters', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify([{ id: 7 }]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(
      JSON.parse(
        toolText(
          await client.callTool({
            name: 'search',
            arguments: { query: 'release build', limit: 4 },
          }),
        ),
      ),
    ).toEqual([{ id: 7 }]);
    await client.callTool({
      name: 'timeline',
      arguments: { session_id: 'session/one', around_id: 12, limit: 8 },
    });
    await client.callTool({
      name: 'get_observations',
      arguments: { ids: [3, 9], expand: false },
    });
    await client.callTool({ name: 'list_sessions', arguments: { limit: 6 } });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://coordinator.test/api/search?q=release%20build&limit=4',
      'https://coordinator.test/api/timeline?session_id=session%2Fone&around_id=12&limit=8',
      'https://coordinator.test/api/observations?ids=3%2C9&expand=false',
      'https://coordinator.test/api/sessions?limit=6',
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => init === undefined)).toBe(true);
  });

  it('forwards coordination writes with identity headers and JSON bodies', async () => {
    vi.stubEnv('CAVEMEM_AGENT_ID', 'agent-a');
    vi.stubEnv('CAVEMEM_PROJECT_ID', 'project-a');
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await client.callTool({
      name: 'create_task',
      arguments: {
        id: 'task/1',
        title: 'Review endpoint mode',
        description: 'Verify forwarding',
        kind: 'test',
        access: 'write',
        mode: 'exclusive',
        scope: ['apps/**'],
      },
    });
    await client.callTool({ name: 'claim_task', arguments: { lease_ms: 5000 } });
    await client.callTool({
      name: 'update_task',
      arguments: { id: 'task/1', status: 'blocked', progress: 'waiting' },
    });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: JSON.parse(String(init?.body)),
    }));

    expect(requests).toEqual([
      {
        url: 'https://coordinator.test/api/tasks',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cavemem-agent-id': 'agent-a',
          'x-cavemem-project-id': 'project-a',
        },
        body: {
          id: 'task/1',
          project_id: 'project-a',
          title: 'Review endpoint mode',
          description: 'Verify forwarding',
          created_by_agent_id: 'agent-a',
          kind: 'test',
          access: 'write',
          mode: 'exclusive',
          scope: ['apps/**'],
        },
      },
      {
        url: 'https://coordinator.test/api/tasks/claim-next',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cavemem-agent-id': 'agent-a',
          'x-cavemem-project-id': 'project-a',
        },
        body: { lease_ms: 5000 },
      },
      {
        url: 'https://coordinator.test/api/tasks/task%2F1',
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-cavemem-agent-id': 'agent-a',
          'x-cavemem-project-id': 'project-a',
        },
        body: { status: 'blocked', progress: 'waiting' },
      },
    ]);
  });

  it('returns endpoint failures as MCP tool errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('coordinator unavailable', { status: 503 })),
    );

    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'anything' },
    });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain(
      'endpoint /api/search?q=anything&limit=10 failed (503): coordinator unavailable',
    );
  });
});
