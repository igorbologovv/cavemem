import type { MemoryStore } from '@cavemem/core';
import type { HookInput } from '../types.js';

export async function sessionStart(store: MemoryStore, input: HookInput): Promise<string> {
  store.startSession({
    id: input.session_id,
    ide: input.ide ?? 'unknown',
    cwd: input.cwd ?? null,
  });

  const blocks: string[] = [];

  const activeTaskContext = activeTaskGuidance(store, input);
  if (activeTaskContext) blocks.push(activeTaskContext);

  if (input.source && input.source !== 'startup') return blocks.join('\n\n');

  const hasActiveTaskContext = activeTaskContext.startsWith('## Active Cavemem task');
  if (hasActiveTaskContext) return blocks.join('\n\n');

  const recent = store.storage.listSessions(20);
  const hints = recent
    .filter((s) => s.id !== input.session_id && (!input.cwd || s.cwd === input.cwd))
    .slice(0, 3)
    .map((s) => {
      const summaries = store.storage.listSummaries(s.id).slice(0, 1);
      return summaries.map((x) => x.content).join('\n');
    })
    .filter(Boolean);

  if (hints.length > 0) {
    blocks.push(`## Prior-session context\n${hints.join('\n---\n')}`);
  }

  return blocks.join('\n\n');
}

function activeTaskGuidance(store: MemoryStore, input: HookInput): string {
  const metadata =
    typeof input.metadata === 'object' && input.metadata !== null && !Array.isArray(input.metadata)
      ? input.metadata
      : {};

  const agentId = typeof metadata.agent_id === 'string' ? metadata.agent_id : undefined;
  const projectId = typeof metadata.project_id === 'string' ? metadata.project_id : undefined;

  if (!agentId || !projectId) return '';

  const task = store.storage.getActiveTaskForAgent({
    agent_id: agentId,
    project_id: projectId,
  });

  if (!task) {
    return [
      '## Cavemem coordination',
      `You are ${agentId} in project ${projectId}.`,
      'No active task is currently claimed by this agent.',
      'Before project work, use cavemem.claim_task to claim a task and follow its contract.',
    ].join('\n');
  }

  const scope = formatScope(task.scope);

  const rules =
    task.access === 'read_only'
      ? [
          'Rules:',
          '- This is a read-only task. Do not edit, create, delete, or format files.',
          '- Inspect code and submit an independent result with cavemem.complete_task.',
          '- If the user asks for implementation work, release or complete this task first and claim a write task.',
        ]
      : [
          'Rules:',
          '- MANDATORY TASK GATE: before using any tool, shell command, file read, file edit, git command, or Cavemem update, compare the user request with this active task.',
          '- If the request is unrelated to this active task, stop immediately and explain the mismatch.',
          '- For unrelated requests, do not inspect files, do not run shell commands, do not run git commands, and do not call Cavemem task tools.',
          '- This is a write task. Edit only files inside the declared scope.',
          '- Work only on the active task description, not merely any file inside scope.',
          '- Mark the task blocked only for blockers discovered while working on this active task.',
          '- Never mark this task blocked because an unrelated user request failed.',
          '- Submit progress with cavemem.update_task and finish with cavemem.complete_task only for this active task.',
        ];

  return [
    '## Active Cavemem task',
    `Agent: ${agentId}`,
    `Project: ${projectId}`,
    `Task: ${task.id} — ${task.title}`,
    `Description: ${task.description}`,
    '',
    'Contract:',
    `- kind: ${task.kind}`,
    `- access: ${task.access}`,
    `- mode: ${task.mode}`,
    `- status: ${task.status}`,
    `- max_claims: ${task.max_claims}`,
    `- required_results: ${task.required_results}`,
    `- scope: ${scope}`,
    '',
    ...rules,
  ].join('\n');
}

function formatScope(scope: string | null): string {
  if (!scope) return '(none)';
  try {
    const parsed = JSON.parse(scope) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String).join(', ');
  } catch {
    // Keep raw scope below.
  }
  return scope;
}
