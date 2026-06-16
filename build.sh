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

# ── configure PATH on Linux ──────────────────────────────────────
configure_path() {
  local bin_dir="$OPENCODE_DIR/dist/opencode-linux-x64/bin"

  # Only run on Linux
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 0
  fi

  # Skip if building a different target
  if [[ ! -d "$bin_dir" ]]; then
    echo "⚠️  Linux binary not found (this build may be for another platform)."
    return 0
  fi

  # Detect shell config file
  local shell="$(basename "$SHELL")"
  local config_file=""
  case "$shell" in
    zsh)  config_file="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) config_file="$HOME/.bashrc" ;;
    *)    config_file="$HOME/.bashrc" ;;
  esac

  local entry="export PATH=\"$bin_dir:\$PATH\""

  # Check if already in the config
  if grep -qF "$bin_dir" "$config_file" 2>/dev/null; then
    echo "✅ PATH already configured in $config_file"
    return 0
  fi

  echo "🔗  Adding $bin_dir to PATH in $config_file..."
  printf '\n%s\n' "$entry" >> "$config_file"
  echo "✅ PATH configured. Run 'source $config_file' or open a new terminal to use 'opencode'."
}

# ── sync ──────────────────────────────────────────────────────────
# Pulls latest changes from the upstream repo (the original
# repository the fork is based on).
sync_repo() {
  echo "⬇️  Syncing fork with upstream..."
  cd "$REPO_ROOT"
  git fetch upstream
  git merge upstream/dev --no-edit

  # Push local commits to origin/dev if any
  echo ""
  echo "📤  Checking for local commits to push..."
  LOCAL_COMMITS=$(git log origin/dev..HEAD --oneline 2>/dev/null || true)
  if [ -n "$LOCAL_COMMITS" ]; then
    echo "  Found local commits:"
    echo "$LOCAL_COMMITS" | sed 's/^/    /'
    echo "  Pushing to origin/dev..."
    git push origin dev || echo "  ⚠️  Push failed, check your connection or permissions."
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
