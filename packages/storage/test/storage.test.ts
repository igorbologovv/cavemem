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
