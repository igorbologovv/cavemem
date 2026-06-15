import { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { ensureWorkerRunning } from './auto-spawn.js';
import { postToolUse } from './handlers/post-tool-use.js';
import { sessionEnd } from './handlers/session-end.js';
import { sessionStart } from './handlers/session-start.js';
import { stop } from './handlers/stop.js';
import { userPromptSubmit } from './handlers/user-prompt-submit.js';
import type { HookInput, HookName, HookResult } from './types.js';

export interface RunHookOptions {
  /**
   * Inject a pre-built MemoryStore (used by tests). When supplied, the runner
   * will not construct or close the store — the caller owns its lifecycle.
   */
  store?: MemoryStore;
}

function endpointFromEnv(): string | undefined {
  const raw = process.env.CAVEMEM_ENDPOINT?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, '');
}

function enrichedInput(input: HookInput): HookInput {
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  };

  const agentId = process.env.CAVEMEM_AGENT_ID?.trim();
  const projectId = process.env.CAVEMEM_PROJECT_ID?.trim();

  if (agentId) metadata.agent_id = agentId;
  if (projectId) metadata.project_id = projectId;

  if (Object.keys(metadata).length === 0) return input;

  return {
    ...input,
    metadata,
  };
}

async function runHookViaEndpoint(name: HookName, input: HookInput): Promise<HookResult> {
  const start = performance.now();
  const endpoint = endpointFromEnv();

  if (!endpoint) {
    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      error: 'CAVEMEM_ENDPOINT is empty',
    };
  }

  const agentId = process.env.CAVEMEM_AGENT_ID?.trim();
  const projectId = process.env.CAVEMEM_PROJECT_ID?.trim();

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (agentId) headers['x-cavemem-agent-id'] = agentId;
  if (projectId) headers['x-cavemem-project-id'] = projectId;

  try {
    const response = await fetch(`${endpoint}/api/hooks/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(enrichedInput(input)),
    });

    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return {
        ok: false,
        ms: Math.round(performance.now() - start),
        error: `endpoint returned non-json response (${response.status}): ${text.slice(0, 200)}`,
      };
    }

    if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) {
      const result = parsed as Partial<HookResult>;
      return {
        ok: Boolean(result.ok),
        ms: typeof result.ms === 'number' ? result.ms : Math.round(performance.now() - start),
        ...(typeof result.context === 'string' ? { context: result.context } : {}),
        ...(typeof result.error === 'string' ? { error: result.error } : {}),
      };
    }

    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      error: `endpoint returned invalid hook result (${response.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runHook(
  name: HookName,
  input: HookInput,
  opts: RunHookOptions = {},
): Promise<HookResult> {
  // Sandbox / multi-agent mode:
  // hooks do not touch SQLite directly. They send events to the common
  // coordinator endpoint, which owns the DB write path.
  //
  // If opts.store is injected, we are already inside the coordinator/tests,
  // so do NOT proxy or we would recurse back into ourselves.
  if (!opts.store && endpointFromEnv()) {
    return runHookViaEndpoint(name, input);
  }

  const start = performance.now();
  const injected = opts.store !== undefined;
  let store: MemoryStore;
  let settingsForSpawn: ReturnType<typeof loadSettings> | undefined;
  if (opts.store) {
    store = opts.store;
  } else {
    const settings = loadSettings();
    settingsForSpawn = settings;
    const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
    store = new MemoryStore({ dbPath, settings });
  }
  try {
    let context: string | undefined;
    switch (name) {
      case 'session-start':
        context = await sessionStart(store, input);
        break;
      case 'user-prompt-submit':
        context = await userPromptSubmit(store, input);
        break;
      case 'post-tool-use':
        await postToolUse(store, input);
        break;
      case 'stop':
        await stop(store, input);
        break;
      case 'session-end':
        await sessionEnd(store, input);
        break;
    }
    // Fire-and-forget: ensure the worker is running so embeddings happen
    // in the background. <2 ms when already running (stat + kill probe).
    // Skipped entirely when a caller injects their own store (tests).
    if (settingsForSpawn && name !== 'session-end') {
      ensureWorkerRunning(settingsForSpawn);
    }
    const result: HookResult = { ok: true, ms: Math.round(performance.now() - start) };
    if (context !== undefined) result.context = context;
    return result;
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!injected) store.close();
  }
}
