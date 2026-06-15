export interface SessionRow {
  id: string;
  ide: string;
  cwd: string | null;
  started_at: number;
  ended_at: number | null;
  metadata: string | null;
}

export interface ObservationRow {
  id: number;
  session_id: string;
  kind: string;
  content: string;
  compressed: 0 | 1;
  intensity: string | null;
  ts: number;
  metadata: string | null;
}

export interface SummaryRow {
  id: number;
  session_id: string;
  scope: 'turn' | 'session';
  content: string;
  compressed: 0 | 1;
  intensity: string | null;
  ts: number;
}

export interface NewObservation {
  session_id: string;
  kind: string;
  content: string;
  compressed: boolean;
  intensity: string | null;
  metadata?: Record<string, unknown>;
  ts?: number;
}

export interface NewSummary {
  session_id: string;
  scope: 'turn' | 'session';
  content: string;
  compressed: boolean;
  intensity: string | null;
  ts?: number;
}

export interface SearchHit {
  id: number;
  session_id: string;
  snippet: string;
  score: number;
  ts: number;
}

export type AgentStatus = 'idle' | 'busy' | 'offline';

export interface AgentRow {
  id: string;
  project_id: string;
  status: AgentStatus;
  last_seen: number;
  current_task_id: string | null;
}

export type TaskKind = 'review' | 'implementation' | 'investigation' | 'test' | 'docs';

export type TaskAccess = 'read_only' | 'write';

export type TaskMode = 'exclusive' | 'parallel_review';

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  kind: TaskKind;
  access: TaskAccess;
  status: TaskStatus;
  mode: TaskMode;
  max_claims: number;
  required_results: number;
  priority: number;
  owner_agent_id: string | null;
  lease_until: number | null;
  scope: string | null;
  result: string | null;
  created_by_agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export type TaskClaimStatus = 'claimed' | 'submitted' | 'released' | 'expired';

export interface TaskClaimRow {
  id: string;
  task_id: string;
  project_id: string;
  agent_id: string;
  status: TaskClaimStatus;
  lease_until: number | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskEventRow {
  id: number;
  task_id: string;
  project_id: string;
  agent_id: string;
  kind: string;
  content: string | null;
  ts: number;
}

export interface ActiveWriteScopeConflict {
  task_id: string;
  title: string;
  agent_id: string | null;
  owner_agent_id: string | null;
  scope: unknown;
}

export interface CreateTaskInput {
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
  scope?: unknown;
  created_by_agent_id?: string | null;
}

export interface ClaimTaskInput {
  project_id: string;
  agent_id: string;
  lease_ms?: number;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  content?: string | null;
  result?: string | null;
  lease_ms?: number;
}

export interface TaskEventInput {
  task_id: string;
  project_id: string;
  agent_id: string;
  kind: string;
  content?: string | null;
}
