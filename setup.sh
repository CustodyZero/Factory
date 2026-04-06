#!/bin/sh
set -e

# Factory Setup Script
#
# Run this from the HOST PROJECT ROOT after adding factory as a submodule:
#
#   git submodule add https://github.com/custodyzero/factory.git .factory
#   ./.factory/setup.sh
#
# Layout after setup:
#   .factory/     — tooling (git submodule, hidden)
#   factory/      — artifacts (features, packets, completions, etc.)
#
# What this script does:
#   1. Installs factory dependencies (inside .factory/)
#   2. Copies template files to host project root (no-clobber)
#   3. Creates artifact directories under factory/
#   4. Configures git hooks

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FACTORY_DIR="$(basename "$SCRIPT_DIR")"
ARTIFACT_DIR="factory"

echo ""
echo "Factory Setup"
echo "============="
echo "  Project root:  ${PROJECT_ROOT}"
echo "  Tooling dir:   ${FACTORY_DIR}/   (submodule)"
echo "  Artifact dir:  ${ARTIFACT_DIR}/  (features, packets, completions)"
echo ""

# ── 1. Install factory dependencies ──────────────────────────────────────────

echo "Installing factory dependencies..."
cd "$SCRIPT_DIR"

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
elif command -v npm >/dev/null 2>&1; then
  npm ci 2>/dev/null || npm install
else
  echo "ERROR: Neither pnpm nor npm found. Node.js is required for factory tooling."
  exit 1
fi

cd "$PROJECT_ROOT"

# ── 2. Copy template files (no-clobber) ─────────────────────────────────────

copy_template() {
  src="$1"
  dest="$2"
  if [ -f "$dest" ]; then
    echo "  SKIP  ${dest} (already exists)"
  else
    cp "$src" "$dest"
    echo "  COPY  ${dest}"
  fi
}

echo ""
echo "Copying template files..."
copy_template "${FACTORY_DIR}/templates/factory.config.json" "factory.config.json"
copy_template "${FACTORY_DIR}/templates/CLAUDE.md" "CLAUDE.md"
copy_template "${FACTORY_DIR}/templates/AGENTS.md" "AGENTS.md"

# ── 3. Create artifact directories ──────────────────────────────────────────

echo ""
echo "Creating artifact directories..."
for subdir in intents features packets completions acceptances rejections evidence supervisor; do
  mkdir -p "${ARTIFACT_DIR}/${subdir}"
  echo "  MKDIR ${ARTIFACT_DIR}/${subdir}/"
done

copy_template "${FACTORY_DIR}/templates/SUPERVISOR.md" "${ARTIFACT_DIR}/supervisor/SUPERVISOR.md"
copy_template "${FACTORY_DIR}/templates/memory.md" "${ARTIFACT_DIR}/supervisor/memory.md"

# ── 4. Configure git hooks ──────────────────────────────────────────────────

echo ""
echo "Configuring git hooks..."
git config core.hooksPath "${FACTORY_DIR}/hooks"
echo "  Set core.hooksPath = ${FACTORY_DIR}/hooks"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "Factory setup complete."
echo ""
echo "Next steps:"
echo "  1. Edit factory.config.json — set project_name and verification commands"
echo "  2. Edit CLAUDE.md — customize for your project"
echo "  3. Run: npx tsx ${FACTORY_DIR}/tools/supervise.ts --init  (initialize supervisor)"
echo "  4. Run: npx tsx ${FACTORY_DIR}/tools/status.ts"
echo ""
