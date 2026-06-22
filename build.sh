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
OPENCODE_DIR="$REPO_ROOT/packages/opencode"

# ── configure PATH ───────────────────────────────────────────────
configure_path() {
  local scripts_dir="$REPO_ROOT/scripts"
  local old_bin_dir="$OPENCODE_DIR/dist/opencode-darwin-arm64/bin"

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

# ── ensure scripts are executable ───────────────────────────────────
ensure_scripts_executable() {
  local script="$REPO_ROOT/scripts/opencodeplus"
  if [[ -f "$script" ]]; then
    chmod +x "$script"
    echo "✅ opencodeplus executable."
  fi
}

# ── sync ──────────────────────────────────────────────────────────
# Pulls latest changes from the upstream repo (the original
# repository the fork is based on).
sync_repo() {
  echo "⬇️  Syncing fork with upstream..."
  cd "$REPO_ROOT"

  # Fetch both remotes
  git fetch origin
  git fetch upstream

  # Stash local changes so merges can proceed
  if ! git stash push -m "build-sync: temporary stash" --include-untracked 2>/dev/null; then
    echo "⚠️  No local changes to stash."
  fi

  # Merge origin/dev first so local commits are integrated
  if ! git merge origin/dev --no-edit; then
    echo "⚠️  Merge conflict with origin/dev — cannot auto-resolve."
    echo "  Please resolve conflicts manually and run: git push origin dev"
    exit 1
  fi

  # Then merge upstream/dev
  if ! git merge upstream/dev --no-edit; then
    echo "⚠️  Merge conflict with upstream/dev — cannot auto-resolve."
    echo "  Please resolve conflicts manually and run: git push origin dev"
    exit 1
  fi

  # Restore stashed changes (fail if conflicts)
  if ! git stash pop 2>/dev/null; then
    echo "⚠️  Stash conflict — please resolve manually."
    exit 1
  fi

  # Push local commits to origin/dev if any
  echo ""
  echo "📤  Checking for local commits to push..."
  LOCAL_COMMITS=$(git log origin/dev..HEAD --oneline 2>/dev/null || true)
  if [ -n "$LOCAL_COMMITS" ]; then
    echo "  Found local commits:"
    echo "$LOCAL_COMMITS" | sed 's/^/    /'
    echo "  Pushing to origin/dev..."
    if git push origin dev; then
      echo "  ✅ Pushed."
    else
      echo "  ⚠️  Push failed, check your connection or permissions."
    fi
  else
    echo "  No local commits to push."
  fi
  echo ""
  echo "✅ Synced."
}

# ── install dependencies ──────────────────────────────────────────
install_deps() {
  echo "📦  Installing dependencies (this may take a few minutes)..."
  cd "$REPO_ROOT"
  if ! bun install; then
    echo "⚠️  bun install failed with exit code $?" >&2
    exit 1
  fi
  echo "✅ Dependencies installed."
}

# ── build ─────────────────────────────────────────────────────────
build() {
  echo "🔨  Building opencode (single target)..."
  cd "$OPENCODE_DIR"
  bun run script/build.ts --single
  echo "✅ Build complete."
}

# ── main ──────────────────────────────────────────────────────────
skip_sync=false
skip_install=false

for arg in "$@"; do
  case "$arg" in
    --skip-sync) skip_sync=true ;;
    --skip-install) skip_install=true ;;
  esac
done

if [[ "$skip_sync" == true ]]; then
  if [[ "$skip_install" != true ]]; then
    install_deps
  fi
  build
  configure_path
else
  sync_repo
  install_deps
  build
  configure_path
  ensure_scripts_executable
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
