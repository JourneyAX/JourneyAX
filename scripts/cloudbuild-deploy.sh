#!/usr/bin/env bash
# ============================================================
# scripts/cloudbuild-deploy.sh
#
# Step 3 of Cloud Build pipeline (runs in cloud-sdk image).
# Adapted from Metafy AI's cloudbuild-deploy.sh.
#
# - Sources /workspace/build_config.sh from Step 1
# - Reads /workspace/services_to_deploy.txt from Step 1
# - Runs `gcloud run deploy` for each service
# - Applies per-service Cloud Run config, secrets, and env vars
#
# CRITICAL: Uses --update-env-vars and --update-secrets (NEVER --set-*)
# to avoid wiping existing vars set by update-urls or manual config.
# ============================================================
set -euo pipefail

source /workspace/build_config.sh

if [ ! -s /workspace/services_to_deploy.txt ]; then
  echo "✅ No services to deploy — skipping."
  exit 0
fi

# ────────────────────────────────────────────────────────────
# Ensure all required Secret Manager secrets exist.
# Uses --replication-policy=automatic (GCP-managed replication).
# Idempotent: silently skips secrets that already exist.
# Secrets are created EMPTY — populate them via:
#   echo -n "value" | gcloud secrets versions add SECRET_NAME --data-file=-
# ────────────────────────────────────────────────────────────
ensure_secret() {
  local NAME="$1"
  if ! gcloud secrets describe "${NAME}" --project="${PROJECT_ID}" &>/dev/null; then
    echo "  🔐 Creating secret: ${NAME}"
    gcloud secrets create "${NAME}" \
      --project="${PROJECT_ID}" \
      --replication-policy=automatic \
      --labels="managed-by=cloud-build,environment=${ENVIRONMENT}"
    echo "  ⚠️  ${NAME} created but has NO VALUE — add a version before deploying!"
  fi
}

echo ""
echo "============================================================"
echo "🔐 Ensuring Secret Manager secrets exist..."
echo "============================================================"

# Shared / infrastructure secrets
ensure_secret "MONGODB_URI"
ensure_secret "JWT_SECRET"
ensure_secret "JWT_REFRESH_SECRET"
ensure_secret "INTERNAL_API_KEY"
ensure_secret "REDIS_URL"

# AI provider keys
ensure_secret "OPENAI_API_KEY"
ensure_secret "GEMINI_API_KEY"
ensure_secret "CLAUDE_API_KEY"
ensure_secret "PERPLEXITY_API_KEY"

# Commerce
ensure_secret "STRIPE_SECRET_KEY"

# WhatsApp (Meta) — moved from Storefront to agent-commerce-service
ensure_secret "WHATSAPP_VERIFY_TOKEN"
ensure_secret "WHATSAPP_APP_SECRET"

echo "✅ All secrets verified."


# Read services into array
SERVICES=()
while IFS= read -r line; do
  [ -n "${line}" ] && SERVICES+=("${line}")
done < /workspace/services_to_deploy.txt

echo "============================================================"
echo "🚀 Deploy to Cloud Run"
echo "   Environment: ${ENVIRONMENT}"
echo "   Project    : ${PROJECT_ID}"
echo "   Commit     : ${COMMIT_SHA}"
echo "   Services   : ${#SERVICES[@]}"
echo "============================================================"

deploy_service() {
  local SVC="$1"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🚀 Deploying: ${SVC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  IMAGE="${REGISTRY}/${PROJECT_ID}/${ARTIFACT_REPO}/${SVC}"

  # ── Per-service Cloud Run scaling / resources ──────────────────────────────
  # Mirrors deployment plan §3a
  case "${SVC}" in
    api-gateway)                 MIN=1; MAX=20; MEM=1Gi;   CPU=2; PORT=8080; RUN_TIMEOUT=300s ;;
    auth-service)                MIN=1; MAX=10; MEM=512Mi; CPU=1; PORT=8080; RUN_TIMEOUT=300s ;;
    agent-commerce-service)      MIN=0; MAX=5;  MEM=1Gi;   CPU=2; PORT=3004; RUN_TIMEOUT=300s ;;
    product-service)             MIN=0; MAX=5;  MEM=1Gi;   CPU=1; PORT=8083; RUN_TIMEOUT=300s ;;
    project-service)             MIN=0; MAX=5;  MEM=512Mi; CPU=1; PORT=8082; RUN_TIMEOUT=300s ;;
    organization-service)        MIN=0; MAX=5;  MEM=512Mi; CPU=1; PORT=8085; RUN_TIMEOUT=300s ;;
    *)                           MIN=0; MAX=5;  MEM=512Mi; CPU=1; PORT=8080; RUN_TIMEOUT=300s ;;
  esac

  # ── Per-service Secret Manager secrets ────────────────────────────────────
  case "${SVC}" in
    auth-service)
      SECRETS="MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,JWT_REFRESH_SECRET=JWT_REFRESH_SECRET:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest" ;;
    agent-commerce-service)
      SECRETS="MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,CLAUDE_API_KEY=CLAUDE_API_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,PERPLEXITY_API_KEY=PERPLEXITY_API_KEY:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest,STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,REDIS_URL=REDIS_URL:latest,WHATSAPP_VERIFY_TOKEN=WHATSAPP_VERIFY_TOKEN:latest,WHATSAPP_APP_SECRET=WHATSAPP_APP_SECRET:latest" ;;
    product-service)
      SECRETS="MONGODB_URI=MONGODB_URI:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest" ;;
    api-gateway)
      # REDIS_URL activates the edge response cache (resp:* namespace in Upstash).
      # @journeyax/cache in each service uses the same secret (data:* namespace).
      # Provision Upstash Redis and add REDIS_URL to Secret Manager to activate.
      SECRETS="MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest,REDIS_URL=REDIS_URL:latest" ;;
    project-service|organization-service)
      SECRETS="MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest,REDIS_URL=REDIS_URL:latest" ;;
    *)
      SECRETS="MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest" ;;
  esac

  # ── Per-service env vars ───────────────────────────────────────────────────
  SVC_ENV="NODE_ENV=production,SERVICE_NAME=${SVC},ENVIRONMENT=${ENVIRONMENT}"

  # Agent service gets extra rate/LLM config
  if [ "${SVC}" = "agent-commerce-service" ]; then
    SVC_ENV="${SVC_ENV},LLM_MODEL=gpt-4o-mini,CHAT_RATE_PER_MIN_IP=30,CHAT_RATE_PER_MIN_SESSION=15,CHAT_MAX_MESSAGE_CHARS=4000,CHAT_MAX_MESSAGES=40"
  fi

  # Gateway gets auth bypass flag
  if [ "${SVC}" = "api-gateway" ]; then
    SVC_ENV="${SVC_ENV},AUTH_DEV_BYPASS=false"
  fi

  # ── Auth flag: gateway + auth-service are the ONLY public entry points.
  # All other backend services are kept private; the gateway calls them
  # using its Cloud Run service account + Google ID token (see gateway.service.ts).
  if [ "${SVC}" = "api-gateway" ] || [ "${SVC}" = "auth-service" ]; then
    AUTH_FLAG="--allow-unauthenticated"
  else
    AUTH_FLAG="--no-allow-unauthenticated"
  fi

  # ── Deploy ─────────────────────────────────────────────────────────────────
  gcloud run deploy "${SVC}" \
    --image="${IMAGE}:${COMMIT_SHA}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --platform=managed \
    ${AUTH_FLAG} \
    --min-instances="${MIN}" \
    --max-instances="${MAX}" \
    --memory="${MEM}" \
    --cpu="${CPU}" \
    --timeout="${RUN_TIMEOUT}" \
    --concurrency=80 \
    --port="${PORT}" \
    --update-env-vars="${SVC_ENV}" \
    --update-secrets="${SECRETS}" \
    --update-labels="service=${SVC},environment=${ENVIRONMENT},managed-by=cloud-build,git-sha=${COMMIT_SHA}"

  # ── Grant gateway's SA run.invoker on private services (idempotent) ─────────
  # The gateway mints a Google ID token for each downstream service URL.
  # Cloud Run validates that token, so the gateway's SA needs invoker on each
  # private service. We discover the SA from the gateway's own config so this
  # works even if the SA ever changes.
  if [ "${SVC}" != "api-gateway" ] && [ "${SVC}" != "auth-service" ]; then
    GATEWAY_SA=$(gcloud run services describe api-gateway \
      --region="${REGION}" --project="${PROJECT_ID}" \
      --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null \
      || gcloud projects describe "${PROJECT_ID}" \
           --format='value(projectNumber)' 2>/dev/null | sed 's/$/-compute@developer.gserviceaccount.com/')
    if [ -n "${GATEWAY_SA}" ]; then
      echo "🔐 Granting roles/run.invoker on ${SVC} to gateway SA: ${GATEWAY_SA}"
      gcloud run services add-iam-policy-binding "${SVC}" \
        --region="${REGION}" --project="${PROJECT_ID}" \
        --member="serviceAccount:${GATEWAY_SA}" \
        --role="roles/run.invoker" 2>/dev/null \
        || echo "  ⚠️  IAM binding skipped (will retry on next deploy)"
    fi
  fi

  # ── Print URL ──────────────────────────────────────────────────────────────
  SVC_URL=$(gcloud run services describe "${SVC}" \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --format='value(status.url)' 2>/dev/null || echo "")
  [ -n "${SVC_URL}" ] && echo "✅ ${SVC} → ${SVC_URL}"
}

for SVC in "${SERVICES[@]}"; do
  deploy_service "${SVC}"
done

echo ""
echo "✅ All services deployed to Cloud Run!"
