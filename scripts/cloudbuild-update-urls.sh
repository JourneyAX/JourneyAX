#!/usr/bin/env bash
# ============================================================
# scripts/cloudbuild-update-urls.sh
#
# Called by cloudbuild.yaml Step 4.
# Adapted from Metafy AI's cloudbuild-update-urls.sh.
#
# Collects all Cloud Run service URLs and injects them into:
#   (a) api-gateway              – routes all external traffic
#   (b) auth-service             – PROJECT, ORG urls
#   (c) agent-commerce-service   – PRODUCT, PROJECT urls
#   (d) product-service          – PROJECT url
#   (e) project-service          – AUTH, ORG urls
#   (f) organization-service     – AUTH, PROJECT urls
#
# Required env vars (injected by Cloud Build built-in substitutions):
#   PROJECT_ID   – GCP project (auto-injected)
#   BRANCH_NAME  – triggering branch (auto-injected)
#   COMMIT_SHA   – commit hash (auto-injected)
# ============================================================
set -euo pipefail

# Source shared config written by cloudbuild-detect.sh
source /workspace/build_config.sh

echo ""
echo "============================================================"
echo "🔗 Injecting internal service URLs"
echo "   Environment : ${ENVIRONMENT}"
echo "   Project     : ${PROJECT_ID}"
echo "============================================================"

# ── Collect all Cloud Run service URLs ────────────────────────────────────────
ALL_SVCS=(
  "api-gateway"
  "auth-service"
  "project-service"
  "product-service"
  "organization-service"
  "agent-commerce-service"
)

echo "🔍 Fetching all Cloud Run service URLs..."
declare -A URL_MAP
for SVC in "${ALL_SVCS[@]}"; do
  URL=$(gcloud run services describe "${SVC}" \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --format='value(status.url)' 2>/dev/null || echo "")
  if [ -n "${URL}" ]; then
    VAR=$(echo "${SVC}" | tr '[:lower:]-' '[:upper:]_')_URL
    URL_MAP["${VAR}"]="${URL}"
    echo "  ✅ ${VAR} = ${URL}"
  else
    echo "  ⏭️  ${SVC} not deployed yet – skipping"
  fi
done

# ── Helper: safely get a URL from map ─────────────────────────────────────────
get_url() {
  local KEY="$1"
  echo "${URL_MAP[${KEY}]:-}"
}

GATEWAY_URL=$(get_url "API_GATEWAY_URL")
AUTH_URL=$(get_url "AUTH_SERVICE_URL")
PROJECT_URL=$(get_url "PROJECT_SERVICE_URL")
PRODUCT_URL=$(get_url "PRODUCT_SERVICE_URL")
ORG_URL=$(get_url "ORGANIZATION_SERVICE_URL")
AGENT_URL=$(get_url "AGENT_COMMERCE_SERVICE_URL")

COMMON_SECRETS="MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest"

# ── (a) api-gateway – inject all service URLs via ~ delimiter ─────────────────
# Use ^~^ prefix so gcloud uses ~ as delimiter (URLs can contain commas)
echo ""
echo "🚀 Updating api-gateway with all service URLs..."

GATEWAY_ENV="NODE_ENV=production~SERVICE_NAME=api-gateway~ENVIRONMENT=${ENVIRONMENT}"
GATEWAY_ENV="${GATEWAY_ENV}~AUTH_DEV_BYPASS=false"

for VAR in "${!URL_MAP[@]}"; do
  [ "${VAR}" = "API_GATEWAY_URL" ] && continue
  GATEWAY_ENV="${GATEWAY_ENV}~${VAR}=${URL_MAP[${VAR}]}"
done

gcloud run services update api-gateway \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --update-env-vars="^~^${GATEWAY_ENV}" \
  --update-secrets="${COMMON_SECRETS}" 2>/dev/null || \
  echo "  ⚠️  api-gateway not yet deployed – will get URLs on next deploy"

# ── (b) auth-service → project, organization ──────────────────────────────────
AUTH_ENV="NODE_ENV=production,SERVICE_NAME=auth-service,ENVIRONMENT=${ENVIRONMENT}"
[ -n "${PROJECT_URL}" ] && AUTH_ENV="${AUTH_ENV},PROJECT_SERVICE_URL=${PROJECT_URL}"
[ -n "${ORG_URL}" ]     && AUTH_ENV="${AUTH_ENV},ORGANIZATION_SERVICE_URL=${ORG_URL}"

echo "🔧 Updating auth-service..."
gcloud run services update auth-service \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --update-env-vars="${AUTH_ENV}" \
  --update-secrets="MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,JWT_REFRESH_SECRET=JWT_REFRESH_SECRET:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest" 2>/dev/null || \
  echo "  ⚠️  auth-service not yet deployed – will get URLs on next deploy"

# ── (c) agent-commerce-service → product, project ────────────────────────────
AGENT_ENV="NODE_ENV=production,SERVICE_NAME=agent-commerce-service,ENVIRONMENT=${ENVIRONMENT}"
AGENT_ENV="${AGENT_ENV},LLM_MODEL=gpt-4o-mini"
AGENT_ENV="${AGENT_ENV},CHAT_RATE_PER_MIN_IP=30,CHAT_RATE_PER_MIN_SESSION=15"
AGENT_ENV="${AGENT_ENV},CHAT_MAX_MESSAGE_CHARS=4000,CHAT_MAX_MESSAGES=40"
[ -n "${PRODUCT_URL}" ] && AGENT_ENV="${AGENT_ENV},PRODUCT_SERVICE_URL=${PRODUCT_URL}"
[ -n "${PROJECT_URL}" ] && AGENT_ENV="${AGENT_ENV},PROJECT_SERVICE_URL=${PROJECT_URL}"

echo "🔧 Updating agent-commerce-service..."
gcloud run services update agent-commerce-service \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --update-env-vars="${AGENT_ENV}" \
  --update-secrets="MONGODB_URI=MONGODB_URI:latest,JWT_SECRET=JWT_SECRET:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,CLAUDE_API_KEY=CLAUDE_API_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,PERPLEXITY_API_KEY=PERPLEXITY_API_KEY:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest,STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,WHATSAPP_VERIFY_TOKEN=WHATSAPP_VERIFY_TOKEN:latest,WHATSAPP_APP_SECRET=WHATSAPP_APP_SECRET:latest" 2>/dev/null || \
  echo "  ⚠️  agent-commerce-service not yet deployed – will get URLs on next deploy"

# ── (d) product-service → project ────────────────────────────────────────────
PRODUCT_ENV="NODE_ENV=production,SERVICE_NAME=product-service,ENVIRONMENT=${ENVIRONMENT}"
[ -n "${PROJECT_URL}" ] && PRODUCT_ENV="${PRODUCT_ENV},PROJECT_SERVICE_URL=${PROJECT_URL}"

echo "🔧 Updating product-service..."
gcloud run services update product-service \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --update-env-vars="${PRODUCT_ENV}" \
  --update-secrets="MONGODB_URI=MONGODB_URI:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,INTERNAL_API_KEY=INTERNAL_API_KEY:latest" 2>/dev/null || \
  echo "  ⚠️  product-service not yet deployed – will get URLs on next deploy"

# ── (e) project-service → auth, organization ─────────────────────────────────
PROJECT_ENV="NODE_ENV=production,SERVICE_NAME=project-service,ENVIRONMENT=${ENVIRONMENT}"
[ -n "${AUTH_URL}" ] && PROJECT_ENV="${PROJECT_ENV},AUTH_SERVICE_URL=${AUTH_URL}"
[ -n "${ORG_URL}" ]  && PROJECT_ENV="${PROJECT_ENV},ORGANIZATION_SERVICE_URL=${ORG_URL}"

echo "🔧 Updating project-service..."
gcloud run services update project-service \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --update-env-vars="${PROJECT_ENV}" \
  --update-secrets="${COMMON_SECRETS}" 2>/dev/null || \
  echo "  ⚠️  project-service not yet deployed – will get URLs on next deploy"

# ── (f) organization-service → auth, project ─────────────────────────────────
ORG_ENV="NODE_ENV=production,SERVICE_NAME=organization-service,ENVIRONMENT=${ENVIRONMENT}"
[ -n "${AUTH_URL}" ]    && ORG_ENV="${ORG_ENV},AUTH_SERVICE_URL=${AUTH_URL}"
[ -n "${PROJECT_URL}" ] && ORG_ENV="${ORG_ENV},PROJECT_SERVICE_URL=${PROJECT_URL}"

echo "🔧 Updating organization-service..."
gcloud run services update organization-service \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --update-env-vars="${ORG_ENV}" \
  --update-secrets="${COMMON_SECRETS}" 2>/dev/null || \
  echo "  ⚠️  organization-service not yet deployed – will get URLs on next deploy"

echo ""
echo "✅ All internal service URL injections complete!"
echo ""
echo "============================================================"
echo "🎉 Cloud Build deployment pipeline complete!"
echo "   Environment : ${ENVIRONMENT}"
echo "   Project     : ${PROJECT_ID}"
echo "   Commit SHA  : ${COMMIT_SHA}"
echo "============================================================"
echo ""
echo "📋 Set these in Vercel (server-side env vars):"
[ -n "${GATEWAY_URL}" ] && echo "  GATEWAY_URL=${GATEWAY_URL}"
[ -n "${AUTH_URL}" ]    && echo "  AUTH_SERVICE_URL=${AUTH_URL}"
[ -n "${PROJECT_URL}" ] && echo "  PROJECT_SERVICE_URL=${PROJECT_URL}"
[ -n "${ORG_URL}" ]     && echo "  ORG_SERVICE_URL=${ORG_URL}"
