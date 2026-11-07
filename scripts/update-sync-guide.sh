#!/usr/bin/env bash
set -euo pipefail

# ─── update-sync-guide.sh ─────────────────────────────────────────
# Regenerates the machine-generated sections of UPSTREAM_SYNC.md
# from live git state:
#   - the divergence snapshot (between SYNC-GUIDE:SNAPSHOT markers)
#   - a new sync-log entry (inserted before SYNC-GUIDE:CHANGELOG:END)
#
# Usage:
#   bash scripts/update-sync-guide.sh          # update the document
#   bash scripts/update-sync-guide.sh --check  # print stats, no changes
#
# Run it after every sync with upstream (see UPSTREAM_SYNC.md §6).
# ──────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$REPO_ROOT/UPSTREAM_SYNC.md"
FORK_BRANCH="${FORK_BRANCH:-dev}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-upstream/dev}"
SNAP_BEGIN="SYNC-GUIDE:SNAPSHOT:BEGIN"
SNAP_END="SYNC-GUIDE:SNAPSHOT:END"
LOG_END="SYNC-GUIDE:CHANGELOG:END"

# ── classify a fork-added file into its area ─────────────────────
classify_area() {
  local f="$1"
  case "$f" in
    packages/core/src/plugin/builtin/antigravity/*|packages/tui/src/feature-plugins/antigravity/*|packages/opencode/src/provider/provider.ts|packages/opencode/test/provider/header-timeout.test.ts)
      echo "antigravity" ;;
    packages/core/src/plugin/builtin/hierarchical-objectives.ts|packages/core/src/plugin/builtin/objectives-*.ts|packages/core/src/config/plugin/objectives.ts|packages/schema/src/config/objectives.ts|packages/tui/src/feature-plugins/sidebar/objectives.tsx|packages/tui/src/routes/session/dialog-plan-approval.tsx|packages/tui/test/feature-plugins/sidebar-objectives.test.tsx|packages/core/test/plugin/builtin/*objectives*.test.ts|packages/core/test/plugin/builtin/antigravity.test.ts|packages/core/test/plugin/builtin/loop-guard.test.ts|packages/core/test/plugin/builtin/compaction-todo.test.ts|packages/core/test/plugin/builtin/subagent-mandatory-instruction.test.ts|packages/core/src/plugin/builtin/loop-guard.ts|packages/core/src/plugin/builtin/compaction-todo.ts|packages/core/src/plugin/builtin/subagent-mandatory-instruction.ts)
      echo "objectives" ;;
    *llamacpp*|packages/core/src/session/unified-kv.ts|packages/core/src/tool/plugin/context-budget.ts|packages/core/src/tool/plugin/session-compact.ts|packages/core/test/tool-context-budget.test.ts|packages/core/test/tool-session-compact.test.ts|packages/opencode/src/session/compaction.ts|packages/opencode/src/session/llm.ts|packages/opencode/src/session/llm/request.ts|packages/opencode/src/session/processor.ts|packages/tui/test/util/dynamic-context-usage.test.ts)
      echo "llamacpp-kv-compaction" ;;
    packages/opencode/src/acp/*|packages/opencode/test/acp/*)
      echo "acp" ;;
    packages/opencode/src/server/routes/instance/httpapi/*experimental*|packages/opencode/test/server/session-actions.test.ts|packages/opencode/test/server/httpapi-exercise/index.ts)
      echo "experimental-httpapi" ;;
    packages/opencode/src/plugin/*|packages/cli/script/embed-plugins.ts|packages/opencode/script/build.ts|packages/core/src/plugin/builtin/index.ts)
      echo "embedded-plugin-build" ;;
    build.sh|scripts/*)
      echo "scripts-tooling" ;;
    AGENT_METHODOLOGY.md|ARCHITECTURE.md|UPSTREAM_SYNC.md)
      echo "docs" ;;
    *)
      echo "misc" ;;
  esac
}

# ── compute divergence stats (sets global variables) ─────────────
compute_stats() {
  if ! git -C "$REPO_ROOT" rev-parse --verify "$UPSTREAM_BRANCH" >/dev/null 2>&1; then
    echo "error: $UPSTREAM_BRANCH not found — run 'git fetch upstream' first" >&2
    exit 1
  fi
  MB="$(git -C "$REPO_ROOT" merge-base "$FORK_BRANCH" "$UPSTREAM_BRANCH")"
  MB_SHORT="$(git -C "$REPO_ROOT" rev-parse --short=10 "$MB")"
  FORK_HEAD="$(git -C "$REPO_ROOT" rev-parse --short=10 "$FORK_BRANCH")"
  UP_HEAD="$(git -C "$REPO_ROOT" rev-parse --short=10 "$UPSTREAM_BRANCH")"
  FORK_AHEAD="$(git -C "$REPO_ROOT" rev-list --count "$MB..$FORK_BRANCH")"
  FORK_NONMERGE="$(git -C "$REPO_ROOT" rev-list --count --no-merges "$MB..$FORK_BRANCH")"
  UP_PENDING="$(git -C "$REPO_ROOT" rev-list --count "$FORK_BRANCH..$UPSTREAM_BRANCH")"

  local diff_file
  diff_file="$(mktemp)"
  git -C "$REPO_ROOT" diff --name-status "$UPSTREAM_BRANCH...$FORK_BRANCH" > "$diff_file"
  ADDED_FILES="$(grep -c '^A' "$diff_file" || true)"
  MODIFIED_FILES="$(grep -c '^M' "$diff_file" || true)"
  TOTAL_FILES="$(wc -l < "$diff_file" | tr -d ' ')"

  local shortstat
  shortstat="$(git -C "$REPO_ROOT" diff --shortstat "$UPSTREAM_BRANCH...$FORK_BRANCH")"
  INS="$(printf '%s' "$shortstat" | sed -nE 's/.* ([0-9]+) insertions?\(\+\).*/\1/p')"
  INS="${INS:-0}"
  DEL="$(printf '%s' "$shortstat" | sed -nE 's/.* ([0-9]+) deletions?\(-\).*/\1/p')"
  DEL="${DEL:-0}"

  # Files modified by the fork AND by upstream since the fork point.
  GUARANTEED_COUNT=0
  while read -r f; do
    local c
    c="$(git -C "$REPO_ROOT" rev-list --count "$MB..$UPSTREAM_BRANCH" -- "$f")"
    if [ "$c" -gt 0 ]; then
      GUARANTEED_COUNT=$((GUARANTEED_COUNT + 1))
    fi
  done < <(grep '^M' "$diff_file" | cut -f2)

  # Fork-added files classified by area.
  AREAS_FILE="$(mktemp)"
  while read -r f; do
    printf '%s\t%s\n' "$(classify_area "$f")" "$f" >> "$AREAS_FILE"
  done < <(grep '^A' "$diff_file" | cut -f2)

  DIFF_FILE="$diff_file"
  AREAS_FILE_PATH="$AREAS_FILE"
}

# ── render the snapshot block (stdout) ───────────────────────────
render_snapshot() {
  echo "- **Snapshot date:** $(date +%F)"
  echo "- **Fork point (merge-base):** \`${MB_SHORT}\`"
  echo "- **Fork commits ahead of fork point:** $FORK_AHEAD ($FORK_NONMERGE non-merge)"
  echo "- **Upstream commits pending integration:** $UP_PENDING"
  echo "- **Divergent files:** $TOTAL_FILES (+${INS} / −${DEL}) — ${ADDED_FILES} added by fork, ${MODIFIED_FILES} modified"
  echo "- **Files guaranteed to conflict on next sync:** $GUARANTEED_COUNT (see §4.1)"
  echo ""
  echo "**Fork-added files by area (${ADDED_FILES}):**"
  cut -f1 "$AREAS_FILE" | sort | uniq -c | sort -rn | while read -r count area; do
    local examples
    examples="$(awk -F'\t' -v a="$area" '$1 == a { print $2 }' "$AREAS_FILE" | head -n 3 | paste -sd ',' -)"
    echo "- \`$area\` ($count): ${examples}"
  done
}

# ── extract content between markers (excludes marker lines) ──────
extract_block() {
  local begin_marker="$1" end_marker="$2"
  awk -v b="$begin_marker" -v e="$end_marker" '
    index($0, b) > 0 { inside = 1; next }
    index($0, e) > 0 { inside = 0 }
    inside { print }
  ' "$DOC"
}

# ── replace content between markers (keeps marker lines) ─────────
replace_block() {
  local begin_marker="$1" end_marker="$2" content_file="$3"
  local tmp
  tmp="$(mktemp)"
  awk -v b="$begin_marker" -v e="$end_marker" -v cf="$content_file" '
    index($0, b) > 0 {
      print
      while ((getline line < cf) > 0) print line
      close(cf)
      skip = 1
      next
    }
    index($0, e) > 0 { skip = 0 }
    !skip { print }
  ' "$DOC" > "$tmp"
  mv "$tmp" "$DOC"
}

# ── insert one line before a marker line ─────────────────────────
insert_before_marker() {
  local marker="$1" line="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v m="$marker" -v l="$line" '
    index($0, m) > 0 { print l }
    { print }
  ' "$DOC" > "$tmp"
  mv "$tmp" "$DOC"
}

main() {
  local check_only=false
  if [ "${1:-}" = "--check" ]; then
    check_only=true
  fi
  if [ ! -f "$DOC" ]; then
    echo "error: $DOC not found" >&2
    exit 1
  fi

  compute_stats

  local snapshot_file
  snapshot_file="$(mktemp)"
  render_snapshot > "$snapshot_file"

  if $check_only; then
    cat "$snapshot_file"
    rm -f "$snapshot_file" "$DIFF_FILE" "$AREAS_FILE"
    return 0
  fi

  local current
  current="$(extract_block "$SNAP_BEGIN" "$SNAP_END")"
  if [ "$current" = "$(cat "$snapshot_file")" ]; then
    rm -f "$snapshot_file" "$DIFF_FILE" "$AREAS_FILE"
    echo "✅ $DOC snapshot already up to date — no changes made."
    return 0
  fi

  replace_block "$SNAP_BEGIN" "$SNAP_END" "$snapshot_file"

  local entry
  entry="| $(date +%F) | \`${FORK_HEAD}\` | \`${UP_HEAD}\` | snapshot: fork $FORK_AHEAD ahead ($FORK_NONMERGE non-merge), upstream $UP_PENDING pending, $TOTAL_FILES divergent ($ADDED_FILES A / $MODIFIED_FILES M), $GUARANTEED_COUNT guaranteed conflicts |"
  insert_before_marker "$LOG_END" "$entry"

  rm -f "$snapshot_file" "$DIFF_FILE" "$AREAS_FILE"
  echo "✅ $DOC updated: snapshot regenerated, sync-log entry appended."
  echo "   merge-base ${MB_SHORT} · fork ${FORK_AHEAD} ahead (${FORK_NONMERGE} non-merge) · upstream ${UP_PENDING} pending · $GUARANTEED_COUNT guaranteed conflicts"
}

main "$@"
