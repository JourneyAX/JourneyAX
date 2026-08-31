#!/usr/bin/env bash
# ============================================================
# scripts/cloudbuild-detect.sh
#
# Step 1 of Cloud Build pipeline (runs in cloud-sdk image).
# Adapted from Metafy AI's cloudbuild-detect.sh.
#
# - Detects which services changed via git diff
# - Writes /workspace/services_to_deploy.txt  (one service per line)
# - Writes /workspace/build_config.sh          (sourced by later steps)
# - Configures Docker credentials for Artifact Registry
#   (credentials are shared with gcr.io/cloud-builders/docker steps
#    via the /root/.docker volume that Cloud Build mounts across all steps)
# ============================================================
set -euo pipefail

REGION="us-central1"
REGISTRY="us-central1-docker.pkg.dev"
ARTIFACT_REPO="journeyax-services"

if [ "${BRANCH_NAME}" = "JourneyAX-QA" ]; then
  ENVIRONMENT="qa"
else
  ENVIRONMENT="production"
fi

echo "============================================================"
echo "🔍 Detect Changes"
echo "   Branch : ${BRANCH_NAME}"
echo "   Env    : ${ENVIRONMENT}"
echo "   Project: ${PROJECT_ID}"
echo "   Commit : ${COMMIT_SHA}"
echo "============================================================"

# Write shared config for downstream steps to source
cat > /workspace/build_config.sh <<EOF
REGION="${REGION}"
REGISTRY="${REGISTRY}"
ARTIFACT_REPO="${ARTIFACT_REPO}"
ENVIRONMENT="${ENVIRONMENT}"
PROJECT_ID="${PROJECT_ID}"
COMMIT_SHA="${COMMIT_SHA}"
EOF

# The 6 core services (v1 scope per deployment plan §10.5)
ALL_SVCS=(
  "api-gateway"
  "auth-service"
  "project-service"
  "product-service"
  "organization-service"
  "agent-commerce-service"
  "retexture-service"
)

# ── Compute changed files ────────────────────────────────────────────────────
# Strategy (in priority order, same as Metafy):
#
#  1. Merge-base diff  — most accurate for feature branches / PR merges.
#  2. HEAD^ diff       — fallback when merge-base is unavailable.
#  3. git show HEAD    — last resort.

# Determine the target/base branch name (the branch we're merging INTO)
if [ "${BRANCH_NAME}" = "JourneyAX-QA" ]; then
  BASE_BRANCH="main"
else
  BASE_BRANCH="JourneyAX-QA"
fi

# Attempt merge-base diff first
MERGE_BASE=$(git merge-base HEAD "origin/${BASE_BRANCH}" 2>/dev/null || true)
if [ -n "${MERGE_BASE}" ]; then
  CHANGED=$(git diff "${MERGE_BASE}" HEAD --name-only 2>/dev/null || echo "")
  echo "ℹ️  Using merge-base diff (base: ${BASE_BRANCH}, merge-base: ${MERGE_BASE:0:8})"
else
  # Fallback: single-commit diff
  CHANGED=$(git diff HEAD^ HEAD --name-only 2>/dev/null \
    || git show --name-only --format="" HEAD 2>/dev/null \
    || echo "")
  echo "ℹ️  Using HEAD^ diff (merge-base not available)"
fi

echo ""
echo "📂 Changed files (first 15):"
echo "${CHANGED}" | grep -v '^$' | head -15 || true
echo ""

SERVICES_TO_DEPLOY=()

# ── Filter out files that NEVER affect what gets built ──────────────────────
# Dev tooling, docs (*.md, *.txt), cursor/gemini/codex config,
# env examples, lint config — none of these change Docker image content.
FILTERED=$(echo "${CHANGED}" | grep -vE \
  '(\.(md|txt|mdx)$|\.cursor/|\.clinerules|\.codex/|\.agent/|\.gemini/|\.github/copilot|\.editorconfig|\.eslintrc|\.env\.example|README|CHANGELOG|\.vscode/|\.idea/|skills/)' \
  || true)

echo "📋 Filtered changed files (build-relevant only):"
echo "${FILTERED}" | grep -v '^$' | head -20 || true
echo ""

# Use here-strings (<<<) instead of echo | grep to avoid SIGPIPE with pipefail.
# ── Rules (evaluated in order, first match wins) ─────────────────────────────

# 1. True infra changes → full rebuild
if grep -qE "^(Dockerfile\.template|cloudbuild\.yaml|package-lock\.json|turbo\.json)$" <<< "${FILTERED}"; then
  echo "⚠️  Core infra files changed → deploying ALL services"
  SERVICES_TO_DEPLOY=("${ALL_SVCS[@]}")

# 2. package.json (root only) → full rebuild
elif echo "${FILTERED}" | grep -qE "^package\.json$"; then
  echo "⚠️  Root package.json changed → deploying ALL services"
  SERVICES_TO_DEPLOY=("${ALL_SVCS[@]}")

# 3. Build/deploy scripts changed → full rebuild
elif grep -q "^scripts/" <<< "${FILTERED}"; then
  echo "⚠️  Build scripts changed → deploying ALL services"
  SERVICES_TO_DEPLOY=("${ALL_SVCS[@]}")

# 4. Shared packages changed → full rebuild (all services depend on them)
elif grep -q "^packages/" <<< "${FILTERED}"; then
  echo "⚠️  Shared packages changed → deploying ALL services"
  SERVICES_TO_DEPLOY=("${ALL_SVCS[@]}")

# 5. Only specific service(s) changed → targeted rebuild
else
  for SVC in "${ALL_SVCS[@]}"; do
    if grep -q "^apps/${SVC}/" <<< "${FILTERED}"; then
      SERVICES_TO_DEPLOY+=("${SVC}")
      echo "  → ${SVC} changed"
    fi
  done
fi

if [ ${#SERVICES_TO_DEPLOY[@]} -eq 0 ]; then
  echo "✅ No backend services changed — nothing to deploy."
  # Write empty marker so build-push and deploy steps exit cleanly
  : > /workspace/services_to_deploy.txt
  exit 0
fi

# Write one service per line
printf '%s\n' "${SERVICES_TO_DEPLOY[@]}" > /workspace/services_to_deploy.txt

echo ""
echo "🔨 Services queued for deployment:"
cat /workspace/services_to_deploy.txt
echo ""

# Configure Docker credentials for Artifact Registry.
# Cloud Build shares /root/.docker across all steps in the same build,
# so these credentials are available to the gcr.io/cloud-builders/docker step.
echo "🔐 Configuring Docker credentials for Artifact Registry..."
gcloud auth configure-docker "${REGISTRY}" --quiet
echo "✅ Docker credentials ready"
