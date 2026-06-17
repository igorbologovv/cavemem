#!/usr/bin/env bash
set -euo pipefail

DEFAULT_ROOT="$HOME/cavemem-agents"
SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$DEFAULT_ROOT" ]]; then
  ROOT="$DEFAULT_ROOT"
elif [[ -d "$SCRIPT_ROOT/workspaces" ]]; then
  ROOT="$SCRIPT_ROOT"
else
  ROOT="$DEFAULT_ROOT"
fi
LOCK_ROOT="$ROOT/locks"
DRY_RUN=0
ENDPOINT="http://127.0.0.1:37777"
LOCK_ACQUIRED=0
LOCK_DIR=""

usage() {
  echo "usage: run-agent.sh [--dry-run] [agent-a|agent-b|agent-c]" >&2
}

normalize_project_id() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//'
}

repo_basename() {
  local repo="$1"
  repo="${repo%/}"
  repo="${repo##*/}"
  repo="${repo%.git}"
  printf '%s' "$repo"
}

project_id_for_workspace() {
  local workspace_path="$1"
  local branch_name=""
  local repo_name=""
  local project_id=""
  local origin_url=""
  local top_level=""

  if [[ -f "$workspace_path/.cavemem-project" ]]; then
    project_id="$(sed -n '1{s/^[[:space:]]*//; s/[[:space:]]*$//; p; q;}' "$workspace_path/.cavemem-project")"
  else
    top_level="$(git -C "$workspace_path" rev-parse --show-toplevel 2>/dev/null || true)"
  fi

  if [[ -z "$project_id" && -n "$top_level" ]]; then
    origin_url="$(git -C "$workspace_path" config --get remote.origin.url 2>/dev/null || true)"
    if [[ -n "$origin_url" ]]; then
      repo_name="$(repo_basename "$origin_url")"
    else
      repo_name="$(basename "$top_level")"
    fi

    branch_name="$(git -C "$workspace_path" branch --show-current 2>/dev/null || true)"
    if [[ -z "$branch_name" ]]; then
      branch_name="detached-$(git -C "$workspace_path" rev-parse --short HEAD 2>/dev/null || true)"
    fi

    project_id="${repo_name}__${branch_name}"
  fi

  if [[ -z "$project_id" ]]; then
    project_id="$(basename "$workspace_path")"
  fi

  project_id="$(normalize_project_id "$project_id")"
  if [[ -z "$project_id" ]]; then
    project_id="$(normalize_project_id "$(basename "$workspace_path")")"
  fi
  printf '%s' "$project_id"
}

lock_path_for_agent() {
  printf '%s/%s.lock' "$LOCK_ROOT" "$1"
}

lock_available() {
  [[ ! -e "$(lock_path_for_agent "$1")" ]]
}

acquire_lock() {
  local agent="$1"
  LOCK_DIR="$(lock_path_for_agent "$agent")"
  mkdir -p "$LOCK_ROOT"

  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "agent '$agent' is already locked: $LOCK_DIR" >&2
    return 1
  fi

  LOCK_ACQUIRED=1
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

cleanup_lock() {
  if [[ "$LOCK_ACQUIRED" -eq 1 && -n "$LOCK_DIR" && -f "$LOCK_DIR/pid" ]]; then
    if [[ "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" == "$$" ]]; then
      rm -f "$LOCK_DIR/pid"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
  fi
}

trap cleanup_lock EXIT INT TERM

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

if [[ "$#" -gt 1 ]]; then
  usage
  exit 2
fi

AGENT="${1:-}"

if [[ -z "$AGENT" ]]; then
  shopt -s nullglob
  WORKSPACE_SLOTS=("$ROOT"/workspaces/agent-*)
  shopt -u nullglob

  if [[ "${#WORKSPACE_SLOTS[@]}" -eq 0 ]]; then
    echo "no agent workspaces found under $ROOT/workspaces" >&2
    exit 1
  fi

  for WORKSPACE_LINK_CANDIDATE in "${WORKSPACE_SLOTS[@]}"; do
    CANDIDATE_AGENT="$(basename "$WORKSPACE_LINK_CANDIDATE")"
    if lock_available "$CANDIDATE_AGENT"; then
      AGENT="$CANDIDATE_AGENT"
      break
    fi
  done

  if [[ -z "$AGENT" ]]; then
    echo "no free agent slots found under $ROOT/workspaces" >&2
    exit 1
  fi
else
  WORKSPACE_LINK_CANDIDATE="$ROOT/workspaces/$AGENT"
  if [[ ! -e "$WORKSPACE_LINK_CANDIDATE" && ! -L "$WORKSPACE_LINK_CANDIDATE" ]]; then
    echo "agent workspace not found: $WORKSPACE_LINK_CANDIDATE" >&2
    exit 1
  fi
fi

WORKSPACE_LINK="$ROOT/workspaces/$AGENT"
WORKSPACE_PATH="$(realpath "$WORKSPACE_LINK")"
PROJECT_ID="$(project_id_for_workspace "$WORKSPACE_PATH")"
LOCK_WOULD_BE_ACQUIRED="yes"

if ! lock_available "$AGENT"; then
  LOCK_WOULD_BE_ACQUIRED="no"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'selected agent: %s\n' "$AGENT"
  printf 'project id: %s\n' "$PROJECT_ID"
  printf 'workspace link: %s\n' "$WORKSPACE_LINK"
  printf 'resolved workspace path: %s\n' "$WORKSPACE_PATH"
  printf 'endpoint: %s\n' "$ENDPOINT"
  printf 'lock would be acquired: %s\n' "$LOCK_WOULD_BE_ACQUIRED"
  exit 0
fi

acquire_lock "$AGENT"

AGENT_HOME="$ROOT/$AGENT/home"
WORKSPACE="$WORKSPACE_LINK"
DB_BIND_ARGS=(
  # --dir /shared
  # --dir /shared/cavemem
  # --bind "$ROOT/shared-memory" /shared/cavemem
)

NODE_DIR="$HOME/.nvm"
NPM_GLOBAL="$HOME/.npm-global"
CAVEMEM_REPO="$HOME/cavemem-lab/cavemem"

bwrap \
  --die-with-parent \
  --dev-bind /dev /dev \
  --proc /proc \
  --ro-bind /usr /usr \
  --ro-bind /bin /bin \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /etc /etc \
  --tmpfs /tmp \
  --dir /home \
  --dir /home/igogo \
  --dir /home/igogo/cavemem-lab \
  --dir /home/sandbox \
  --dir /workspace \
  "${DB_BIND_ARGS[@]}" \
  --bind "$AGENT_HOME" /home/sandbox \
  --bind "$WORKSPACE" /workspace \
  --ro-bind "$NODE_DIR" /home/igogo/.nvm \
  --ro-bind "$NPM_GLOBAL" /home/igogo/.npm-global \
  --ro-bind "$CAVEMEM_REPO" /home/igogo/cavemem-lab/cavemem \
  --setenv HOME /home/sandbox \
  --setenv USER sandbox \
  --setenv CAVEMEM_ENDPOINT "$ENDPOINT" \
  --setenv CAVEMEM_AGENT_ID "$AGENT" \
  --setenv CAVEMEM_PROJECT_ID "$PROJECT_ID" \
  --setenv PATH "/home/igogo/.npm-global/bin:/home/igogo/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin" \
  --chdir /workspace \
  /bin/bash
