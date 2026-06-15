import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Storage', () => {
  it('stores and retrieves observations', () => {
    storage.createSession({
      id: 'sess-1',
      ide: 'claude-code',
      cwd: '/tmp',
      started_at: Date.now(),
      metadata: null,
    });
    const id = storage.insertObservation({
      session_id: 'sess-1',
      kind: 'note',
      content: 'db config updated',
      compressed: true,
      intensity: 'full',
    });
    const rows = storage.getObservations([id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.compressed).toBe(1);
  });

  it('FTS search finds matches', () => {
    storage.createSession({
      id: 's',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertObservation({
      session_id: 's',
      kind: 'note',
      content: 'auth middleware throws 401',
      compressed: true,
      intensity: 'full',
    });
    const hits = storage.searchFts('auth');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toContain('[auth]');
  });

  it('FTS search scopes results to cwd when provided (#39)', () => {
    storage.createSession({
      id: 'proj-A',
      ide: 'claude-code',
      cwd: '/work/A',
      started_at: Date.now(),
      metadata: null,
    });
    storage.createSession({
      id: 'proj-B',
      ide: 'claude-code',
      cwd: '/work/B',
      started_at: Date.now(),
      metadata: null,
    });
    storage.insertObservation({
      session_id: 'proj-A',
      kind: 'note',
      content: 'shared keyword in project A',
      compressed: true,
      intensity: 'full',
    });
    storage.insertObservation({
      session_id: 'proj-B',
      kind: 'note',
      content: 'shared keyword in project B',
      compressed: true,
      intensity: 'full',
    });
    expect(storage.searchFts('keyword').length).toBe(2);
    const scopedA = storage.searchFts('keyword', 10, '/work/A');
    expect(scopedA).toHaveLength(1);
    expect(scopedA[0]?.session_id).toBe('proj-A');
    const scopedB = storage.searchFts('keyword', 10, '/work/B');
    expect(scopedB).toHaveLength(1);
    expect(scopedB[0]?.session_id).toBe('proj-B');
  });

  it('stores and retrieves embeddings', () => {
    storage.createSession({
      id: 's2',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const id = storage.insertObservation({
      session_id: 's2',
      kind: 'note',
      content: 'x',
      compressed: true,
      intensity: 'full',
    });
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    storage.putEmbedding(id, 'test-model', vec);
    const got = storage.getEmbedding(id);
    expect(got?.dim).toBe(3);
    expect(Array.from(got?.vec)).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
  });

  it('allEmbeddings filters by model + dim', () => {
    storage.createSession({
      id: 's3',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's3',
          kind: 'note',
          content: `n${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    storage.putEmbedding(ids[0] as number, 'old-model', new Float32Array([1, 2]));
    storage.putEmbedding(ids[1] as number, 'new-model', new Float32Array([1, 2, 3]));
    storage.putEmbedding(ids[2] as number, 'new-model', new Float32Array([4, 5, 6]));

    expect(storage.allEmbeddings().length).toBe(3);
    expect(storage.allEmbeddings({ model: 'new-model', dim: 3 }).length).toBe(2);
    expect(storage.allEmbeddings({ model: 'old-model', dim: 2 }).length).toBe(1);
    expect(storage.allEmbeddings({ model: 'new-model', dim: 2 }).length).toBe(0);
  });

  it('dropEmbeddingsWhereModelNot clears stale rows', () => {
    storage.createSession({
      id: 's4',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const a = storage.insertObservation({
      session_id: 's4',
      kind: 'note',
      content: 'a',
      compressed: true,
      intensity: 'full',
    });
    const b = storage.insertObservation({
      session_id: 's4',
      kind: 'note',
      content: 'b',
      compressed: true,
      intensity: 'full',
    });
    storage.putEmbedding(a, 'old-model', new Float32Array([1]));
    storage.putEmbedding(b, 'new-model', new Float32Array([1]));

    const dropped = storage.dropEmbeddingsWhereModelNot('new-model');
    expect(dropped).toBe(1);
    expect(storage.allEmbeddings().length).toBe(1);
  });

  it('observationsMissingEmbeddings respects the model filter', () => {
    storage.createSession({
      id: 's5',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        storage.insertObservation({
          session_id: 's5',
          kind: 'note',
          content: `n${i}`,
          compressed: true,
          intensity: 'full',
        }),
      );
    }
    storage.putEmbedding(ids[0] as number, 'model-a', new Float32Array([1]));

    // No filter: only ids[0] has an embedding at all, so ids[1] and ids[2] are missing.
    expect(
      storage
        .observationsMissingEmbeddings(10)
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[1], ids[2]].sort());
    // Filter to model-b: ids[0] has no model-b embedding, so all 3 are missing.
    expect(
      storage
        .observationsMissingEmbeddings(10, 'model-b')
        .map((r) => r.id)
        .sort(),
    ).toEqual([ids[0], ids[1], ids[2]].sort());
  });

  it('countObservations + countEmbeddings return correct totals', () => {
    storage.createSession({
      id: 's6',
      ide: 'claude-code',
      cwd: null,
      started_at: Date.now(),
      metadata: null,
    });
    expect(storage.countObservations()).toBe(0);
    const id = storage.insertObservation({
      session_id: 's6',
      kind: 'note',
      content: 'a',
      compressed: true,
      intensity: 'full',
    });
    expect(storage.countObservations()).toBe(1);
    expect(storage.countEmbeddings()).toBe(0);
    storage.putEmbedding(id, 'm', new Float32Array([1]));
    expect(storage.countEmbeddings()).toBe(1);
    expect(storage.countEmbeddings({ model: 'm', dim: 1 })).toBe(1);
    expect(storage.countEmbeddings({ model: 'm', dim: 2 })).toBe(0);
  });

  it('claims a specific low-priority task even when higher-priority work exists', () => {
    storage.createTask({
      id: 'high',
      project_id: 'project-a',
      title: 'High priority',
      description: 'Unrelated work',
      priority: 10,
    });
    storage.createTask({
      id: 'review',
      project_id: 'project-a',
      title: 'Review',
      description: 'Target review',
      mode: 'parallel_review',
      access: 'read_only',
      max_claims: 3,
      required_results: 3,
      priority: 0,
    });

    const claimed = storage.claimTaskById({
      task_id: 'review',
      project_id: 'project-a',
      agent_id: 'agent-a',
    });

    expect(claimed?.id).toBe('review');
    expect(storage.getTask('high')?.status).toBe('todo');
    expect(storage.listTaskClaims('review')).toMatchObject([
      { agent_id: 'agent-a', status: 'claimed' },
    ]);
  });

  it('reuses a released claim row for the same task and agent', () => {
    storage.createTask({
      id: 'review',
      project_id: 'project-a',
      title: 'Review',
      description: 'Target review',
      mode: 'parallel_review',
      access: 'read_only',
      max_claims: 2,
      required_results: 2,
    });
    storage.claimTaskById({
      task_id: 'review',
      project_id: 'project-a',
      agent_id: 'agent-a',
    });
    const originalClaimId = storage.listTaskClaims('review')[0]?.id;
    expect(
      storage.releaseTask({
        id: 'review',
        project_id: 'project-a',
        agent_id: 'agent-a',
      }),
    ).not.toBeNull();

    storage.claimTaskById({
      task_id: 'review',
      project_id: 'project-a',
      agent_id: 'agent-a',
    });

    expect(storage.listTaskClaims('review')).toMatchObject([
      { id: originalClaimId, agent_id: 'agent-a', status: 'claimed' },
    ]);
  });

  it('blocks an active overlapping write scope claim', () => {
    storage.createTask({
      id: 'active',
      project_id: 'project-a',
      title: 'Active write',
      description: 'Owns main',
      access: 'write',
      scope: ['src/main.rs'],
    });
    storage.createTask({
      id: 'same-file',
      project_id: 'project-a',
      title: 'Same file',
      description: 'Also wants main',
      access: 'write',
      scope: ['src/main.rs'],
    });
    storage.createTask({
      id: 'glob',
      project_id: 'project-a',
      title: 'Glob',
      description: 'Broad source write',
      access: 'write',
      scope: ['src/**'],
    });

    expect(
      storage.claimTaskById({ task_id: 'active', project_id: 'project-a', agent_id: 'agent-a' }),
    )?.toMatchObject({ id: 'active', status: 'in_progress' });
    expect(
      storage.claimTaskById({
        task_id: 'same-file',
        project_id: 'project-a',
        agent_id: 'agent-b',
      }),
    ).toBeNull();
    expect(
      storage.claimTaskById({ task_id: 'glob', project_id: 'project-a', agent_id: 'agent-b' }),
    ).toBeNull();
    expect(
      storage.findActiveWriteScopeConflicts({
        project_id: 'project-a',
        scope: ['**'],
        exclude_task_id: 'glob',
      }),
    ).toMatchObject([{ task_id: 'active', agent_id: 'agent-a' }]);
  });

  it('does not block identical write scopes across different projects', () => {
    storage.createTask({
      id: 'project-a-main',
      project_id: 'project-a',
      title: 'Project A main',
      description: 'Owns main in project A',
      access: 'write',
      scope: ['src/main.rs'],
    });
    storage.createTask({
      id: 'project-b-main',
      project_id: 'project-b',
      title: 'Project B main',
      description: 'Owns main in project B',
      access: 'write',
      scope: ['src/main.rs'],
    });

    expect(
      storage.claimTaskById({
        task_id: 'project-a-main',
        project_id: 'project-a',
        agent_id: 'agent-a',
      }),
    ).toMatchObject({ id: 'project-a-main', status: 'in_progress' });
    expect(
      storage.claimTaskById({
        task_id: 'project-b-main',
        project_id: 'project-b',
        agent_id: 'agent-b',
      }),
    ).toMatchObject({ id: 'project-b-main', status: 'in_progress' });
  });

  it('blocks narrower write work when an active broad scope is claimed', () => {
    storage.createTask({
      id: 'broad-dot',
      project_id: 'project-a',
      title: 'Broad dot',
      description: 'Owns the project',
      access: 'write',
      scope: ['.'],
    });
    storage.createTask({
      id: 'narrow-after-dot',
      project_id: 'project-a',
      title: 'Narrow after dot',
      description: 'Wants main',
      access: 'write',
      scope: ['src/main.rs'],
    });
    storage.createTask({
      id: 'broad-star',
      project_id: 'project-b',
      title: 'Broad star',
      description: 'Owns the project',
      access: 'write',
      scope: ['**'],
    });
    storage.createTask({
      id: 'narrow-after-star',
      project_id: 'project-b',
      title: 'Narrow after star',
      description: 'Wants main',
      access: 'write',
      scope: ['src/main.rs'],
    });

    expect(
      storage.claimTaskById({
        task_id: 'broad-dot',
        project_id: 'project-a',
        agent_id: 'agent-a',
      }),
    ).not.toBeNull();
    expect(
      storage.claimTaskById({
        task_id: 'narrow-after-dot',
        project_id: 'project-a',
        agent_id: 'agent-b',
      }),
    ).toBeNull();
    expect(
      storage.claimTaskById({
        task_id: 'broad-star',
        project_id: 'project-b',
        agent_id: 'agent-a',
      }),
    ).not.toBeNull();
    expect(
      storage.claimTaskById({
        task_id: 'narrow-after-star',
        project_id: 'project-b',
        agent_id: 'agent-b',
      }),
    ).toBeNull();
  });

  it('blocks parent and child write scope overlaps in either direction', () => {
    storage.createTask({
      id: 'parent',
      project_id: 'project-a',
      title: 'Parent',
      description: 'Owns app',
      access: 'write',
      scope: ['apps/mcp-server/**'],
    });
    storage.createTask({
      id: 'child',
      project_id: 'project-a',
      title: 'Child',
      description: 'Server file',
      access: 'write',
      scope: ['apps/mcp-server/src/server.ts'],
    });
    expect(
      storage.claimTaskById({ task_id: 'parent', project_id: 'project-a', agent_id: 'agent-a' }),
    ).not.toBeNull();
    expect(
      storage.claimTaskById({ task_id: 'child', project_id: 'project-a', agent_id: 'agent-b' }),
    ).toBeNull();

    storage.releaseTask({ id: 'parent', project_id: 'project-a', agent_id: 'agent-a' });
    expect(
      storage.claimTaskById({ task_id: 'child', project_id: 'project-a', agent_id: 'agent-b' }),
    ).not.toBeNull();
    expect(
      storage.claimTaskById({ task_id: 'parent', project_id: 'project-a', agent_id: 'agent-c' }),
    ).toBeNull();
  });

  it('allows non-overlapping write scopes and overlapping read-only review claims', () => {
    storage.createTask({
      id: 'active',
      project_id: 'project-a',
      title: 'Active',
      description: 'MCP work',
      access: 'write',
      scope: ['apps/mcp-server/**'],
    });
    storage.createTask({
      id: 'storage',
      project_id: 'project-a',
      title: 'Storage',
      description: 'Storage work',
      access: 'write',
      scope: ['packages/storage/**'],
    });
    storage.createTask({
      id: 'review',
      project_id: 'project-a',
      title: 'Review',
      description: 'Read-only review',
      kind: 'review',
      access: 'read_only',
      mode: 'parallel_review',
      scope: ['apps/mcp-server/src/server.ts'],
      max_claims: 3,
      required_results: 3,
    });

    expect(
      storage.claimTaskById({ task_id: 'active', project_id: 'project-a', agent_id: 'agent-a' }),
    ).not.toBeNull();
    expect(
      storage.claimTaskById({ task_id: 'storage', project_id: 'project-a', agent_id: 'agent-b' }),
    ).toMatchObject({ id: 'storage', status: 'in_progress' });
    expect(
      storage.claimTaskById({ task_id: 'review', project_id: 'project-a', agent_id: 'agent-c' }),
    ).toMatchObject({ id: 'review', status: 'in_progress' });
  });

  it('does not block on completed or released write tasks', () => {
    storage.createTask({
      id: 'done',
      project_id: 'project-a',
      title: 'Done',
      description: 'Old write',
      access: 'write',
      scope: ['src/main.rs'],
    });
    storage.createTask({
      id: 'next',
      project_id: 'project-a',
      title: 'Next',
      description: 'New write',
      access: 'write',
      scope: ['src/**'],
    });
    storage.claimTaskById({ task_id: 'done', project_id: 'project-a', agent_id: 'agent-a' });
    storage.completeTask({ id: 'done', project_id: 'project-a', agent_id: 'agent-a' });

    expect(
      storage.claimTaskById({ task_id: 'next', project_id: 'project-a', agent_id: 'agent-b' }),
    ).toMatchObject({ id: 'next' });
    storage.releaseTask({ id: 'next', project_id: 'project-a', agent_id: 'agent-b' });
    expect(
      storage.claimTaskById({ task_id: 'next', project_id: 'project-a', agent_id: 'agent-c' }),
    ).toMatchObject({ id: 'next' });
  });

  it('claimNext skips write tasks with locked scopes', () => {
    storage.createTask({
      id: 'active',
      project_id: 'project-a',
      title: 'Active',
      description: 'Owns main',
      access: 'write',
      priority: 10,
      scope: ['src/main.rs'],
    });
    storage.createTask({
      id: 'blocked',
      project_id: 'project-a',
      title: 'Blocked',
      description: 'Overlaps main',
      access: 'write',
      priority: 9,
      scope: ['.'],
    });
    storage.createTask({
      id: 'safe',
      project_id: 'project-a',
      title: 'Safe',
      description: 'Separate package',
      access: 'write',
      priority: 1,
      scope: ['packages/storage/**'],
    });
    storage.claimTaskById({ task_id: 'active', project_id: 'project-a', agent_id: 'agent-a' });

    expect(storage.claimNextTask({ project_id: 'project-a', agent_id: 'agent-b' })).toMatchObject({
      id: 'safe',
    });
    expect(storage.getTask('blocked')).toMatchObject({ status: 'todo' });
  });

  it('rejects completion without an active claim and leaves the task unchanged', () => {
    storage.createTask({
      id: 'task-a',
      project_id: 'project-a',
      title: 'Task',
      description: 'Protected task',
    });

    expect(
      storage.completeTask({
        id: 'task-a',
        project_id: 'project-a',
        agent_id: 'agent-a',
        result: 'not allowed',
      }),
    ).toBeNull();
    expect(storage.getTask('task-a')).toMatchObject({ status: 'todo', result: null });
    expect(storage.listTaskClaims('task-a')).toEqual([]);
  });

  it('prevents another agent or project from mutating an active task', () => {
    storage.createTask({
      id: 'task-a',
      project_id: 'project-a',
      title: 'Task',
      description: 'Protected task',
    });
    storage.claimTaskById({
      task_id: 'task-a',
      project_id: 'project-a',
      agent_id: 'owner',
    });

    expect(
      storage.updateTask('task-a', {
        project_id: 'project-a',
        agent_id: 'intruder',
        status: 'blocked',
      }),
    ).toBeNull();
    expect(
      storage.completeTask({
        id: 'task-a',
        project_id: 'project-b',
        agent_id: 'owner',
      }),
    ).toBeNull();
    expect(
      storage.releaseTask({
        id: 'task-a',
        project_id: 'project-a',
        agent_id: 'intruder',
      }),
    ).toBeNull();
    expect(storage.getTask('task-a')).toMatchObject({
      status: 'in_progress',
      owner_agent_id: 'owner',
    });
    expect(storage.listTaskClaims('task-a')).toMatchObject([
      { agent_id: 'owner', status: 'claimed' },
    ]);
  });

  it('finishes a parallel review only after the required submitted claims', () => {
    storage.createTask({
      id: 'review',
      project_id: 'project-a',
      title: 'Review',
      description: 'Two independent reviews',
      mode: 'parallel_review',
      access: 'read_only',
      max_claims: 3,
      required_results: 2,
    });
    storage.claimTaskById({
      task_id: 'review',
      project_id: 'project-a',
      agent_id: 'agent-a',
    });
    storage.claimTaskById({
      task_id: 'review',
      project_id: 'project-a',
      agent_id: 'agent-b',
    });

    expect(
      storage.completeTask({
        id: 'review',
        project_id: 'project-a',
        agent_id: 'agent-a',
        result: 'first',
      }),
    ).toMatchObject({ status: 'in_progress' });
    const claims = storage.listTaskClaims('review');
    expect(claims).toHaveLength(2);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: 'agent-a',
          status: 'submitted',
          result: 'first',
        }),
        expect.objectContaining({ agent_id: 'agent-b', status: 'claimed' }),
      ]),
    );

    expect(
      storage.completeTask({
        id: 'review',
        project_id: 'project-a',
        agent_id: 'agent-b',
        result: 'second',
      }),
    ).toMatchObject({ status: 'done' });
  });

  it('caps the completion threshold for legacy parallel tasks', () => {
    storage.createTask({
      id: 'legacy-review',
      project_id: 'project-a',
      title: 'Legacy review',
      description: 'Required results exceeds max claims',
      mode: 'parallel_review',
      access: 'read_only',
      max_claims: 2,
      required_results: 2,
    });
    const db = (
      storage as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
      }
    ).db;
    db.prepare('UPDATE tasks SET required_results = 3 WHERE id = ?').run('legacy-review');

    for (const agent_id of ['agent-a', 'agent-b']) {
      storage.claimTaskById({
        task_id: 'legacy-review',
        project_id: 'project-a',
        agent_id,
      });
    }

    expect(
      storage.completeTask({
        id: 'legacy-review',
        project_id: 'project-a',
        agent_id: 'agent-a',
        result: 'first',
      }),
    ).toMatchObject({ status: 'in_progress' });
    expect(
      storage.completeTask({
        id: 'legacy-review',
        project_id: 'project-a',
        agent_id: 'agent-b',
        result: 'second',
      }),
    ).toMatchObject({ status: 'done' });
  });

  it('closes surplus parallel claims and prevents submissions after completion', () => {
    storage.createTask({
      id: 'review-with-surplus',
      project_id: 'project-a',
      title: 'Review',
      description: 'Two results from three claims',
      mode: 'parallel_review',
      access: 'read_only',
      max_claims: 3,
      required_results: 2,
    });
    for (const agent_id of ['agent-a', 'agent-b', 'agent-c']) {
      storage.claimTaskById({
        task_id: 'review-with-surplus',
        project_id: 'project-a',
        agent_id,
      });
    }

    storage.completeTask({
      id: 'review-with-surplus',
      project_id: 'project-a',
      agent_id: 'agent-a',
      result: 'first',
    });
    expect(
      storage.completeTask({
        id: 'review-with-surplus',
        project_id: 'project-a',
        agent_id: 'agent-b',
        result: 'second',
      }),
    ).toMatchObject({ status: 'done' });

    expect(storage.listTaskClaims('review-with-surplus')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent_id: 'agent-a', status: 'submitted' }),
        expect.objectContaining({ agent_id: 'agent-b', status: 'submitted' }),
        expect.objectContaining({ agent_id: 'agent-c', status: 'released' }),
      ]),
    );
    expect(storage.listAgents('project-a')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-a',
          status: 'idle',
          current_task_id: null,
        }),
        expect.objectContaining({
          id: 'agent-b',
          status: 'idle',
          current_task_id: null,
        }),
        expect.objectContaining({
          id: 'agent-c',
          status: 'idle',
          current_task_id: null,
        }),
      ]),
    );
    expect(
      storage.completeTask({
        id: 'review-with-surplus',
        project_id: 'project-a',
        agent_id: 'agent-c',
        result: 'late',
      }),
    ).toBeNull();
    expect(storage.listTaskEvents('review-with-surplus')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: 'agent-c',
          kind: 'released',
        }),
      ]),
    );
  });
});
