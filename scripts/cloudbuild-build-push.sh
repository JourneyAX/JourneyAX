#!/usr/bin/env bash
# ============================================================
# scripts/cloudbuild-build-push.sh
#
# Step 2 of Cloud Build pipeline (runs in gcr.io/cloud-builders/docker).
# Adapted from Metafy AI's cloudbuild-build-push.sh.
#
# - Sources /workspace/build_config.sh from Step 1
# - Reads /workspace/services_to_deploy.txt from Step 1
# - Builds Docker image for each service IN PARALLEL (4 concurrent)
# - Pushes both :latest and :<COMMIT_SHA> tags to Artifact Registry
#
# Speed optimisations:
#   DOCKER_BUILDKIT=1  → parallelises multi-stage Dockerfile stages
#                        internally (your 4-stage Dockerfile runs
#                        dependencies + prod-dependencies in parallel)
#   MAX_PARALLEL=4     → up to 4 service builds run concurrently on
#                        the 8-vCPU E2_HIGHCPU_8 machine
#                        (6 services ÷ 4 = ~2 batches vs 6 sequential)
#
# Docker credentials were configured in Step 1 via
# `gcloud auth configure-docker` and are shared across all steps
# via Cloud Build's /root/.docker volume mount.
# ============================================================
set -euo pipefail

export DOCKER_BUILDKIT=1

source /workspace/build_config.sh

if [ ! -s /workspace/services_to_deploy.txt ]; then
  echo "✅ No services to build — skipping."
  exit 0
fi

# Read services into array
SERVICES=()
while IFS= read -r line; do
  [ -n "${line}" ] && SERVICES+=("${line}")
done < /workspace/services_to_deploy.txt

echo "============================================================"
echo "🐳 Build & Push Docker Images (parallel, max 4 concurrent)"
echo "   Registry : ${REGISTRY}"
echo "   Project  : ${PROJECT_ID}"
echo "   Commit   : ${COMMIT_SHA}"
echo "   Services : ${#SERVICES[@]}"
echo "   BuildKit : enabled (multi-stage Dockerfile parallelism)"
echo "============================================================"

# ── Per-service build + push function ─────────────────────────────────────────
build_push_svc() {
  local SVC="$1"
  local IMAGE="${REGISTRY}/${PROJECT_ID}/${ARTIFACT_REPO}/${SVC}"
  # A service may ship its OWN Dockerfile (e.g. the Python retexture-service,
  # which the Node Dockerfile.template can't build). When present, use it with
  # the SERVICE directory as the build context (self-contained, no workspace).
  local DOCKERFILE="Dockerfile.template"
  local CONTEXT="."
  if [ -f "apps/${SVC}/Dockerfile" ]; then
    DOCKERFILE="apps/${SVC}/Dockerfile"
    CONTEXT="apps/${SVC}"
    echo "  [${SVC}] ℹ Using per-service Dockerfile (context: ${CONTEXT})"
  fi

  echo "🔨 [START] ${SVC}"

  # ── Pull previous image to warm the layer cache ────────────────────────
  # Cloud Build workers have NO local Docker cache between builds.
  # We must explicitly pull :latest so the layers are present locally
  # before --cache-from can use them.  Falls back gracefully on first build.
  docker pull "${IMAGE}:latest" 2>/dev/null \
    && echo "  [${SVC}] ✓ Cache warmed from :latest" \
    || echo "  [${SVC}] ℹ No cache available (first build or new service)"

  # ── Build with BuildKit inline cache ──────────────────────────────────
  # BUILDKIT_INLINE_CACHE=1  embeds the layer cache manifest into the pushed
  # image so the NEXT build can use --cache-from and actually find layers.
  # Without this flag, --cache-from is a no-op (no cache map in the image).
  DOCKER_BUILDKIT=1 docker build \
    --build-arg "SERVICE_NAME=${SVC}" \
    --build-arg "BUILDKIT_INLINE_CACHE=1" \
    --cache-from "${IMAGE}:latest" \
    -t "${IMAGE}:latest" \
    -t "${IMAGE}:${COMMIT_SHA}" \
    -f "${DOCKERFILE}" \
    "${CONTEXT}" 2>&1 | sed "s/^/  [${SVC}] /"

  docker push --all-tags "${IMAGE}" 2>&1 | sed "s/^/  [${SVC}] /"

  echo "✅ [DONE ] ${SVC} → ${IMAGE}:${COMMIT_SHA}"
}


export -f build_push_svc
export REGISTRY PROJECT_ID ARTIFACT_REPO COMMIT_SHA

# ── Parallel execution with concurrency limit ──────────────────────────────────
# Cloud Build E2_HIGHCPU_8 = 8 vCPUs / 8 GB RAM.
# MAX_PARALLEL=4 gives each build 2 vCPUs with headroom.
MAX_PARALLEL=4

declare -a PIDS=()
declare -a FAILED_SVCS=()

wait_for_slot() {
  # If we have MAX_PARALLEL jobs running, wait for one to finish before starting more
  while [ "${#PIDS[@]}" -ge "${MAX_PARALLEL}" ]; do
    local new_pids=()
    for pid in "${PIDS[@]}"; do
      if kill -0 "${pid}" 2>/dev/null; then
        new_pids+=("${pid}")
      else
        # Job finished — check exit code
        if ! wait "${pid}"; then
          FAILED_SVCS+=("pid:${pid}")
        fi
      fi
    done
    PIDS=("${new_pids[@]+"${new_pids[@]}"}")
    [ "${#PIDS[@]}" -lt "${MAX_PARALLEL}" ] && break
    sleep 1
  done
}

echo ""
echo "▶ Launching builds (${#SERVICES[@]} services, ${MAX_PARALLEL} parallel)..."
echo ""

for SVC in "${SERVICES[@]}"; do
  wait_for_slot
  build_push_svc "${SVC}" &
  PIDS+=($!)
done

# Wait for all remaining background jobs
echo ""
echo "⏳ Waiting for all builds to complete..."
for pid in "${PIDS[@]}"; do
  wait "${pid}" || FAILED_SVCS+=("pid:${pid}")
done

echo ""
if [ "${#FAILED_SVCS[@]}" -gt 0 ]; then
  echo "❌ Some builds failed: ${FAILED_SVCS[*]}"
  exit 1
fi

echo "✅ All ${#SERVICES[@]} images built and pushed successfully!"
