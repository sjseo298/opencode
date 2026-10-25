#!/usr/bin/env bash
set -euo pipefail

# ─── build.sh ─────────────────────────────────────────────────────
# Syncs the fork with upstream and builds opencode for the current
# platform (--single).
#
# Usage:
#   ./build.sh                    # sync with upstream + install deps + build
#   ./build.sh --skip-sync        # install deps + build only
#   ./build.sh --skip-install     # build only
# ──────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_DIR="$REPO_ROOT/packages/cli"

# ── configure PATH ───────────────────────────────────────────────
configure_path() {
  local scripts_dir="$REPO_ROOT/scripts"
  local old_bin_dir="$OPENCODE_DIR/dist/cli-darwin-arm64/bin"

  # Detect shell config file
  local shell="$(basename "$SHELL")"
  local config_file=""
  case "$shell" in
    zsh)  config_file="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) config_file="$HOME/.bashrc" ;;
    *)    config_file="$HOME/.bashrc" ;;
  esac

  # Remove old opencode binary PATH entry
  if grep -qF "$old_bin_dir" "$config_file" 2>/dev/null; then
    echo "🗑️  Removing old opencode binary PATH entry..."
    sed -i '' "/opencode-darwin-arm64/d" "$config_file"
    echo "✅ Old PATH entry removed."
  fi

  # Also remove old scripts_dir entry if it exists (idempotent)
  if grep -qF "$scripts_dir" "$config_file" 2>/dev/null; then
    echo "✅ PATH already configured in $config_file"
    return 0
  fi

  local entry="export PATH=\"$scripts_dir:\$PATH\""
  echo "🔗  Adding $scripts_dir to PATH in $config_file..."
  printf '\n%s\n' "$entry" >> "$config_file"
  echo "✅ PATH configured. Run 'source $config_file' or open a new terminal to use 'opencodeplus'."
}

# ── ensure bun version ─────────────────────────────────────────────
# Checks if upstream requires a newer version of bun (via packageManager in package.json)
# and performs a cold upgrade before dependency installation or agent execution.
ensure_bun_version() {
  local target_ref="${1:-upstream/dev}"
  if ! command -v bun >/dev/null 2>&1; then
    echo "⚠️  Bun no está instalado en el sistema."
    return 0
  fi

  local current_bun
  current_bun="$(bun --version 2>/dev/null | tr -d 'v' || echo "")"
  if [[ -z "$current_bun" ]]; then
    return 0
  fi

  # Extract packageManager from target_ref package.json if available
  local pkg_manager
  pkg_manager="$(git -C "$REPO_ROOT" show "${target_ref}:package.json" 2>/dev/null | grep -E '"packageManager"' | head -n 1 || true)"
  if [[ -z "$pkg_manager" ]]; then
    return 0
  fi

  # Expected format: "packageManager": "bun@1.4.4"
  local required_bun
  required_bun="$(echo "$pkg_manager" | sed -E 's/.*"bun@([0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?).*/\1/')"
  if [[ -z "$required_bun" || "$required_bun" == "$pkg_manager" ]]; then
    return 0
  fi

  # Compare semver versions
  if [ "$(printf '%s\n' "$required_bun" "$current_bun" | sort -V | head -n1)" != "$required_bun" ]; then
    echo "⬆️  Upstream requiere Bun >= $required_bun (actual: $current_bun). Actualizando Bun en frío..."
    if command -v brew >/dev/null 2>&1 && brew list bun >/dev/null 2>&1; then
      echo "  Ejecutando: brew upgrade bun"
      brew upgrade bun || bun upgrade || true
    else
      echo "  Ejecutando: bun upgrade"
      bun upgrade || true
    fi
    local new_bun
    new_bun="$(bun --version 2>/dev/null || echo "$current_bun")"
    echo "✅ Bun actualizado a: $new_bun"
  fi
}

# ── ensure scripts are executable ───────────────────────────────────
ensure_scripts_executable() {
  local script="$REPO_ROOT/scripts/opencodeplus"
  if [[ -f "$script" ]]; then
    chmod +x "$script"
    echo "✅ opencodeplus executable."
  fi
  local os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  local arch="$(uname -m)"
  [[ "$arch" == "x86_64" ]] && arch="x64"
  [[ "$arch" == "aarch64" ]] && arch="arm64"
  local target_bin="$OPENCODE_DIR/dist/cli-${os}-${arch}/bin/opencode"
  if [[ -f "$target_bin" ]]; then
    ln -sf "$target_bin" "$REPO_ROOT/scripts/opencode"
    chmod +x "$REPO_ROOT/scripts/opencode"
    echo "✅ Linked opencode to $REPO_ROOT/scripts/opencode"
  fi
}


# ── resolve conflicts ─────────────────────────────────────────────
# Attempts to resolve merge/stash conflicts using LLM.
# Returns 0 if resolved and verified (compile/typecheck), 1 if manual resolution needed.
resolve_conflicts_with_llm() {
  local script="$REPO_ROOT/scripts/resolve-conflicts.py"
  if [[ -f "$script" ]]; then
    python3 "$script" --auto --compile
  else
    echo "⚠️  resolve-conflicts.py not found — manual resolution needed."
    return 1
  fi
}

# ── sync ──────────────────────────────────────────────────────────
# Syncs the fork with upstream and/or origin depending on the sync mode.
# - "fork": only sync with origin (the fork)
# - "full": sync with both origin and upstream (the original repo)
sync_repo() {
  local sync_mode="$1"
  cd "$REPO_ROOT"

  if [ "$sync_mode" = "fork" ]; then
    echo "⬇️  Syncing fork (origin) only..."
    git fetch origin

    # Stash local changes so merges can proceed
    if ! git stash push -m "build-sync: temporary stash" --include-untracked 2>/dev/null; then
      echo "⚠️  No local changes to stash."
    fi

    # Merge origin/dev so local commits are integrated
    if ! git merge origin/dev --no-edit; then
      echo "⚠️  Merge conflict with origin/dev — attempting LLM auto-resolution..."
      if resolve_conflicts_with_llm; then
        git add -A
        git commit --no-edit
        echo "✅ Merge conflict resolved."
      else
        echo "  Please resolve conflicts manually and run: git push origin dev"
        exit 1
      fi
    fi

    # Restore stashed changes (attempt LLM auto-resolution if conflicts)
    if ! git stash pop 2>/dev/null; then
      echo "⚠️  Stash conflict — attempting LLM auto-resolution..."
      if resolve_conflicts_with_llm; then
        git add -A
        # Retry stash pop after resolution
        if git stash pop 2>/dev/null; then
          echo "✅ Stash conflict resolved."
        else
          echo "⚠️  Stash conflict persists — please resolve manually after the build."
        fi
      else
        echo "  Please resolve conflicts manually after the build."
      fi
    fi

    echo ""
    echo "  Skipping push (fork-only sync)."
  else
    echo "⬇️  Syncing fork with upstream..."
    # Fetch both remotes
    git fetch origin
    git fetch upstream

    # Verify if upstream requires a newer Bun version before proceeding
    ensure_bun_version "upstream/dev"

    # Stash local changes so merges can proceed
    if ! git stash push -m "build-sync: temporary stash" --include-untracked 2>/dev/null; then
      echo "⚠️  No local changes to stash."
    fi

    # Merge origin/dev first so local commits are integrated
    if ! git merge origin/dev --no-edit; then
      echo "⚠️  Merge conflict with origin/dev — attempting LLM auto-resolution..."
      if resolve_conflicts_with_llm; then
        git add -A
        git commit --no-edit
        echo "✅ Merge conflict resolved."
      else
        echo "  Please resolve conflicts manually and run: git push origin dev"
        exit 1
      fi
    fi

    # Merge upstream/dev
    if ! git merge upstream/dev --no-edit; then
      echo "⚠️  Merge conflict with upstream/dev — attempting LLM auto-resolution..."
      if resolve_conflicts_with_llm; then
        git add -A
        git commit --no-edit
        echo "✅ Merge conflict resolved."
      else
        echo "  Please resolve conflicts manually and run: git push origin dev"
        exit 1
      fi
    fi

    # Restore stashed changes (attempt LLM auto-resolution if conflicts)
    if ! git stash pop 2>/dev/null; then
      echo "⚠️  Stash conflict — attempting LLM auto-resolution..."
      if resolve_conflicts_with_llm; then
        git add -A
        echo "✅ Stash conflict resolved."
      else
        echo "  Please resolve conflicts manually after the build."
      fi
    fi

    # Check for local commits to push
    echo ""
    echo "📤  Checking for local commits to push..."
    local local_commits
    local_commits=$(git log origin/dev..HEAD --oneline 2>/dev/null || true)
    if [ -n "$local_commits" ]; then
      echo "  Found local commits:"
      echo "$local_commits" | sed 's/^/    /'
      echo "  Pushing to origin/dev..."
      if git push origin dev; then
        echo "  ✅ Pushed."
      else
        echo "  ⚠️  Push failed, check your connection or permissions."
      fi
    else
      echo "  No local commits to push."
    fi
  fi

  echo ""
  echo "✅ Synced."
}

# ── install dependencies ──────────────────────────────────────────
install_deps() {
  echo "📦  Installing dependencies (this may take a few minutes)..."
  cd "$REPO_ROOT"
  ensure_bun_version "HEAD"
  if ! bun install; then
    echo "⚠️  bun install failed with exit code $?" >&2
    exit 1
  fi
  echo "✅ Dependencies installed."
}

# ── clean build residuals & temporary artifacts ────────────────────
clean_residuals() {
  echo "🧹  Limpiando archivos residuales y cachés temporales..."
  cd "$REPO_ROOT"
  rm -rf .turbo
  rm -rf "$REPO_ROOT/packages/opencode/dist" 2>/dev/null || true
  rm -rf "$REPO_ROOT/packages/cli/.cache" 2>/dev/null || true
  find "$REPO_ROOT/packages" -maxdepth 3 -name ".*.bun-build" -exec rm -f {} + 2>/dev/null || true
  echo "✅ Archivos residuales eliminados."
}

clean_turbo() {
  clean_residuals
}

# ── typecheck report ──────────────────────────────────────────────
typecheck_report() {
  echo "🔍  Running typecheck..."
  cd "$REPO_ROOT"
  local TYPECHECK_OUTPUT
  TYPECHECK_OUTPUT=$(bun typecheck 2>&1) || true
  local TYPECHECK_EXIT=$?

  if [ $TYPECHECK_EXIT -ne 0 ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚠️  Typecheck errors found — review before pushing"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$TYPECHECK_OUTPUT"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  else
    echo "✅ Typecheck passed."
  fi
}

# ── test local plugins ────────────────────────────────────────────
# Runs tests for custom builtin plugins in packages/core/test/plugin/builtin/
# Does NOT block the build if tests fail — just reports status.
test_plugins() {
  local plugins_test_dir="$REPO_ROOT/packages/core/test/plugin/builtin"
  
  if [[ ! -d "$plugins_test_dir" ]]; then
    echo "⏭️  No plugin tests found (skipping)"
    return 0
  fi

  echo "🧪  Running plugin tests..."
  cd "$plugins_test_dir"
  
  local TEST_OUTPUT
  local TEST_EXIT
  TEST_OUTPUT=$(bun test --timeout 30000 2>&1) || true
  TEST_EXIT=$?

  echo ""
  if [ $TEST_EXIT -eq 0 ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ Plugin tests passed"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$TEST_OUTPUT" | tail -5
  else
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚠️  Plugin tests FAILED — review before pushing"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$TEST_OUTPUT"
  fi
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  cd "$REPO_ROOT"
  return 0  # Never fail the build
}

# ── build ─────────────────────────────────────────────────────────
build() {
  echo "🔨  Building opencode (single target)..."
  cd "$OPENCODE_DIR"
  bun run script/build.ts --single
  clean_residuals
  echo "✅ Build complete."
}

# ── main ──────────────────────────────────────────────────────────
skip_sync=false
skip_install=false
SYNC_MODE=""

for arg in "$@"; do
  case "$arg" in
    --skip-sync) skip_sync=true ;;
    --skip-install) skip_install=true ;;
    --sync-mode=*) SYNC_MODE="${arg#*=}" ;;
  esac
done

if [[ "$skip_sync" == true ]]; then
  if [[ "$skip_install" != true ]]; then
    install_deps
  fi
  clean_turbo
  build
  test_plugins
  typecheck_report
  configure_path
  ensure_scripts_executable
else
  if [[ -z "$SYNC_MODE" ]]; then
    echo ""
    echo "  [1] Solo fork (origin/dev) — sincroniza solo con el fork"
    echo "  [2] Fork + repositorio raíz (upstream/dev) — sincroniza con ambos"
    echo ""
    while true; do
      read -p "  ¿Qué sincronización deseas? [1-2]: " choice
      case "$choice" in
        1) SYNC_MODE="fork"; break ;;
        2) SYNC_MODE="full"; break ;;
        *) echo "  Opción inválida. Ingresa 1 o 2." >&2 ;;
      esac
    done
  fi

  sync_repo "$SYNC_MODE"
  install_deps
  clean_turbo
  build
  test_plugins
  typecheck_report
  configure_path
  ensure_scripts_executable

  # Show the models config path
  echo ""
  echo "📝 Models config: ~/.config/opencode/opencode.jsonc"

  # Verify build output
  echo ""
  echo "📦 Build output:"
  if [[ -d "$OPENCODE_DIR/dist" ]]; then
    ls -lh "$OPENCODE_DIR/dist/" | grep -v "^total" | sed 's/^/   /' || echo "   (no binaries found)"
  else
    echo "   ⚠️  dist/ directory not found — build may have failed."
  fi
fi
