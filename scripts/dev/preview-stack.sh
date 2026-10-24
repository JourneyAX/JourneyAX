#!/usr/bin/env bash
# Try a DRAFT pack end to end before publishing it: a second set of services on their own ports, the draft laid over the live pack
# in memory only. The live services (3008/3010/3004/3012) and the database are not changed; the preview only reads.
#
#   scripts/dev/preview-stack.sh start [tenant] [draft.json]    (defaults: placemakers, docs/agent-instructions/<tenant>-draft.json)
#   scripts/dev/preview-stack.sh stop
#   scripts/dev/preview-stack.sh status
#
# Open the preview storefront at http://localhost:3108/?project=<tenant>  (sign in as usual).
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR="tmp/preview"; mkdir -p "$DIR"
TENANT="${2:-placemakers}"; DRAFT="${3:-docs/agent-instructions/${TENANT}-draft.json}"
RUNTIME_PORT=3112; COMMERCE_PORT=3104; GATEWAY_PORT=3110; WEB_PORT=3108

run() { # name, command...
  local name="$1"; shift
  nohup "$@" >"$DIR/$name.log" 2>&1 &
  echo $! >"$DIR/$name.pid"
  echo "started $name (pid $(cat "$DIR/$name.pid"))"
}
stop_all() {
  for f in "$DIR"/*.pid; do
    [ -f "$f" ] || continue
    pid="$(cat "$f")"; pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; rm -f "$f"
  done
  echo "preview stopped"
}
case "${1:-status}" in
  start)
    stop_all >/dev/null 2>&1 || true
    PREVIEW_TENANT="$TENANT" PREVIEW_DRAFT="$DRAFT" JOURNEY_RUNTIME_PORT=$RUNTIME_PORT \
      run runtime npx tsx --tsconfig tests/public-path/tsconfig.json --env-file=.env scripts/dev/preview-runtime.ts
    PORT=$COMMERCE_PORT JOURNEY_RUNTIME_SERVICE_URL="http://localhost:$RUNTIME_PORT" \
      run commerce npx tsx --tsconfig tests/public-path/tsconfig.json --env-file=.env apps/agent-commerce-service/src/main.ts
    PORT=$GATEWAY_PORT AGENT_SERVICE_URL="http://localhost:$COMMERCE_PORT" JOURNEY_RUNTIME_SERVICE_URL="http://localhost:$RUNTIME_PORT" \
      run gateway npx tsx --tsconfig tests/public-path/tsconfig.json --env-file=.env apps/api-gateway/src/main.ts
    ( cd apps/journeyax-web && NEXT_DIST_DIR=.next-preview GATEWAY_URL="http://localhost:$GATEWAY_PORT" JOURNEY_RUNTIME_URL="http://localhost:$RUNTIME_PORT" \
        nohup npx next dev -p $WEB_PORT >"../../$DIR/web.log" 2>&1 & echo $! >"../../$DIR/web.pid" )
    echo "started web (pid $(cat "$DIR/web.pid"))"
    echo "Preview storefront: http://localhost:$WEB_PORT/?project=$TENANT   (logs in $DIR/)"
    ;;
  stop) stop_all ;;
  status)
    for n in runtime commerce gateway web; do
      if [ -f "$DIR/$n.pid" ] && kill -0 "$(cat "$DIR/$n.pid")" 2>/dev/null; then echo "$n: running (pid $(cat "$DIR/$n.pid"))"; else echo "$n: stopped"; fi
    done ;;
  *) echo "usage: $0 start|stop|status [tenant] [draft.json]"; exit 1 ;;
esac
