#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CDL (Custom Design Line) end-to-end test suite.
#
# Exercises the whole CDL journey against the LIVE local stack:
#   Door B (upload):   analyze(imageUrl) · analyze(imageBase64) · match · render
#   Door A (generate): generateDesign (nano-banana concept) → analyze → match
#   CREATE branch:     no-match design → cut-piece job queued for the artist
#   Artist validation: submit → approve → customer agree → ready for print
#   Chat wiring:       gateway commerce/chat/stream with an attached design →
#                      analyzeDesign fires and showConfigurator is emitted
#
# Usage:
#   bash scripts/cdl/cdl-e2e-test.sh                # all services on default ports
#   PRODUCT=http://localhost:8083 GATEWAY=http://localhost:3010 bash scripts/cdl/cdl-e2e-test.sh
#
# Requires: curl, python3. Services up: product-service(8083), gateway(3010),
# agent(3004). INTERNAL_API_KEY read from repo .env.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PRODUCT="${PRODUCT:-http://localhost:8083}"
GATEWAY="${GATEWAY:-http://localhost:3010}"
PROJECT="${PROJECT:-augusta}"
KEY="$(grep -h '^INTERNAL_API_KEY=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
JERSEY_URL="https://static.momentecbrands.com/product/227130_AAAO_front.jpg"

PASS=0; FAIL=0; SKIP=0
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; SKIP=$((SKIP+1)); }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── prep: fetch the reference jersey and encode it as a base64 data URL ──
curl -s "$JERSEY_URL" -o "$TMP/jersey.jpg"
python3 - "$TMP/jersey.jpg" "$TMP/b64.json" <<'PY'
import base64,json,sys
b=base64.b64encode(open(sys.argv[1],'rb').read()).decode()
json.dump({"imageBase64":"data:image/jpeg;base64,"+b}, open(sys.argv[2],'w'))
PY

# ─────────────────────────────────────────────────────────────────────────────
say "0 · Preflight"
if [ -z "$KEY" ]; then bad "INTERNAL_API_KEY not found in .env"; else ok "internal key loaded"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$PRODUCT/api/v1/$PROJECT/cdl/facets" -H "X-Internal-Key: $KEY")
[ "$code" = "200" ] && ok "product-service /cdl/facets reachable" || bad "product-service unreachable ($code)"

# ─────────────────────────────────────────────────────────────────────────────
say "1 · Template library"
python3 - <<PY
import json,urllib.request
d=json.load(urllib.request.urlopen("$PRODUCT/api/v1/$PROJECT/cdl/facets"))
n=d.get("libraryCount",0)
print("  libraryCount =",n)
import sys; sys.exit(0 if n>=300 else 1)
PY
[ $? -eq 0 ] && ok "library has >=300 templates" || bad "library too small"

# ─────────────────────────────────────────────────────────────────────────────
say "2 · Door B — analyze via imageUrl (USE branch)"
curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/analyze" \
  -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
  -d "{\"imageUrl\":\"$JERSEY_URL\"}" --max-time 60 > "$TMP/a_url.json"
python3 - "$TMP/a_url.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); m=d.get("match",{})
sport=d.get("analysis",{}).get("sport","")
sku=(m.get("best") or {}).get("template",{}).get("parentSku")
print("  sport=%s decision=%s best=%s" % (sport, m.get("decision"), sku))
sys.exit(0 if m.get("decision")=="use" and sku else 1)
PY
[ $? -eq 0 ] && ok "imageUrl → decision=use with a real style code" || bad "imageUrl analyze/match failed"

# ─────────────────────────────────────────────────────────────────────────────
say "3 · Door B — analyze via imageBase64 (413-body-limit regression)"
code=$(curl -s -o "$TMP/a_b64.json" -w '%{http_code}' -X POST "$PRODUCT/api/v1/$PROJECT/cdl/analyze" \
  -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
  --data @"$TMP/b64.json" --max-time 60)
if [ "$code" = "413" ]; then bad "413 — product-service body limit still default (needs 10mb)"
elif [ "$code" = "200" ] || [ "$code" = "201" ]; then
  python3 - "$TMP/a_b64.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); m=d.get("match",{})
sys.exit(0 if m.get("decision") in ("use","create") else 1)
PY
  [ $? -eq 0 ] && ok "base64 data-URL accepted (>100kb) and analyzed" || bad "base64 analyze returned no decision"
else bad "base64 analyze HTTP $code"; fi

# ─────────────────────────────────────────────────────────────────────────────
say "4 · Door B — render the matched template (3D texture + glb)"
SKU=$(python3 -c "import json;print((json.load(open('$TMP/a_url.json')).get('match',{}).get('best') or {}).get('template',{}).get('parentSku',''))")
if [ -n "$SKU" ]; then
  curl -s -X POST "$PRODUCT/api/v1/$PROJECT/products/render" \
    -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
    -d "{\"style\":\"$SKU\",\"colours\":[\"NAVY\",\"ORANGE\",\"WHITE\"]}" --max-time 40 > "$TMP/render.json"
  python3 - "$TMP/render.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("  renderable=%s texture=%s glb=%s" % (d.get("renderable"), bool(d.get("texture")), bool(d.get("geometry",{}).get("glb"))))
sys.exit(0 if d.get("renderable") and d.get("texture") else 1)
PY
  [ $? -eq 0 ] && ok "matched style renders (texture + geometry)" || bad "render failed for $SKU"
else skip "no SKU to render"; fi

# ─────────────────────────────────────────────────────────────────────────────
say "5 · Chat wiring — attached design drives analyzeDesign + showConfigurator"
curl -s -N -X POST "$GATEWAY/api/v1/$PROJECT/commerce/chat/stream" \
  -H "Content-Type: application/json" -H "X-Tenant-ID: $PROJECT" \
  -d "{\"message\":\"Here is my design, make it\",\"imageUrl\":\"$JERSEY_URL\"}" \
  --max-time 150 2>/dev/null > "$TMP/chat.sse"
python3 - "$TMP/chat.sse" <<'PY'
import json,sys
tool=False; cfg=None
for line in open(sys.argv[1]):
    if not line.startswith("data:"): continue
    try: d=json.loads(line[5:].strip())
    except: continue
    if d.get("name")=="showConfigurator": cfg=d.get("arguments") or cfg
    for m in d.get("conversation",[]) or []:
        for tc in (m.get("tool_calls") or []):
            if tc.get("function",{}).get("name")=="analyzeDesign": tool=True
    for a in d.get("uiActions",[]) or []:
        if a.get("name")=="showConfigurator": cfg=a.get("arguments") or cfg
haveColours = bool(cfg and cfg.get("baseColor") and cfg.get("accentColor"))
print("  analyzeDesign=%s configurator=%s base=%s accent=%s" % (tool, bool(cfg), (cfg or {}).get("baseColor"), (cfg or {}).get("accentColor")))
sys.exit(0 if tool and cfg and haveColours else 1)
PY
[ $? -eq 0 ] && ok "chat: analyzeDesign fired + configurator forced WITH base+accent colours" || bad "chat wiring / colours incomplete"

# ─────────────────────────────────────────────────────────────────────────────
say "6 · Door A — generate a concept from a brief (nano-banana) → analyze → match"
if [ "${SKIP_IMAGEGEN:-0}" = "1" ]; then skip "SKIP_IMAGEGEN=1 (image generation calls a paid model)"; else
curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/design" \
  -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
  -d '{"brief":"navy and orange baseball jersey, full button, team Cougars number 30, aggressive modern look"}' \
  --max-time 120 > "$TMP/design.json"
python3 - "$TMP/design.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); m=d.get("match",{})
print("  provider=%s conceptId=%s decision=%s" % (d.get("provider"), bool(d.get("conceptId")), m.get("decision")))
sys.exit(0 if d.get("ok") and d.get("conceptId") and m.get("decision") in ("use","create") else 1)
PY
[ $? -eq 0 ] && ok "brief → concept image generated + matched" || bad "design (Door A) failed"
# the concept image is fetchable by id
CID=$(python3 -c "import json;print(json.load(open('$TMP/design.json')).get('conceptId',''))")
if [ -n "$CID" ]; then
  ct=$(curl -s -o "$TMP/concept.png" -w '%{content_type}' "$PRODUCT/api/v1/$PROJECT/cdl/concept/$CID" -H "X-Internal-Key: $KEY" --max-time 20)
  echo "$ct" | grep -q "image/" && ok "concept image served ($(wc -c < "$TMP/concept.png") bytes, $ct)" || bad "concept image not served ($ct)"
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
say "7 · CREATE branch — a design with no template → decision 'create'"
curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/match" \
  -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
  -d '{"sport":"CRICKET","garmentType":"TOP","division":"Adult","keywords":"cricket whites long sleeve"}' > "$TMP/create.json"
python3 - "$TMP/create.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("  decision=%s exists=%s" % (d.get("decision"), d.get("exists")))
sys.exit(0 if d.get("decision")=="create" else 1)
PY
[ $? -eq 0 ] && ok "no-template design → decision 'create'" || bad "CREATE branch not triggered"

# a required size the template lacks also forces create
curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/match" \
  -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
  -d '{"sport":"BASEBALL","garmentType":"TOP","division":"Adult","keywords":"full button","sizes":["6XL"]}' > "$TMP/create2.json"
python3 -c "import json,sys;sys.exit(0 if json.load(open('$TMP/create2.json')).get('decision')=='create' else 1)"
[ $? -eq 0 ] && ok "missing required size → decision 'create'" || bad "missing-size did not force create"

# ─────────────────────────────────────────────────────────────────────────────
say "8 · Artist validation — submit → (block early agree) → artist approve → customer agree → print"
RSID="cdl-e2e-$$"
JOB=$(curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/review" -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
  -d "{\"sessionId\":\"$RSID\",\"kind\":\"use\",\"sku\":\"345VTS\",\"summary\":\"Navy/orange Cougars #30\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('jobId','') if d.get('status')=='pending_artist' else '')")
[ -n "$JOB" ] && ok "submitForReview → pending_artist" || bad "submit review failed"
if [ -n "$JOB" ]; then
  # early agree must be BLOCKED
  curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/review/$JOB/agree" -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" -d "{\"sessionId\":\"$RSID\"}" \
    | python3 -c "import sys,json;sys.exit(1 if json.load(sys.stdin).get('ok') else 0)"
  [ $? -eq 0 ] && ok "customer CANNOT agree before artist approves (two-gate integrity)" || bad "early agree was NOT blocked"
  # artist approves
  curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/review/$JOB/artist" -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" -d '{"approved":true,"by":"artist-e2e"}' \
    | python3 -c "import sys,json;sys.exit(0 if json.load(sys.stdin).get('status')=='artist_approved' else 1)"
  [ $? -eq 0 ] && ok "artist approves → artist_approved" || bad "artist approval failed"
  # customer agrees → ready_for_print
  curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/review/$JOB/agree" -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" -d "{\"sessionId\":\"$RSID\"}" \
    | python3 -c "import sys,json;sys.exit(0 if json.load(sys.stdin).get('status')=='ready_for_print' else 1)"
  [ $? -eq 0 ] && ok "customer agrees → ready_for_print" || bad "customer agree failed"
fi

# ─────────────────────────────────────────────────────────────────────────────
say "9 · Chat wiring — 'design me…' calls generateDesign (not catalogue search)"
if [ "${SKIP_IMAGEGEN:-0}" = "1" ]; then skip "SKIP_IMAGEGEN=1"; else
# Door A drives a live image-gen; a single Gemini hiccup can drop the concept.
# Retry once before failing so a transient blip doesn't red the suite.
doorA_rc=1
for attempt in 1 2; do
  curl -s -N -X POST "$GATEWAY/api/v1/$PROJECT/commerce/chat/stream" \
    -H "Content-Type: application/json" -H "X-Tenant-ID: $PROJECT" \
    -d '{"message":"Design me a navy and orange baseball jersey for the Cougars, number 30, aggressive modern look","sessionId":"cdl-e2e-doorA-'"$$"'-'"$attempt"'"}' \
    --max-time 180 2>/dev/null > "$TMP/doorA.sse"
  python3 - "$TMP/doorA.sse" <<'PY'
import json,sys
gen=False; concept=False; cfg=False
for line in open(sys.argv[1]):
    if not line.startswith("data:"): continue
    try: d=json.loads(line[5:].strip())
    except: continue
    if d.get("name")=="showConcept": concept=True
    if d.get("name")=="showConfigurator": cfg=True
    for m in d.get("conversation",[]) or []:
        for tc in (m.get("tool_calls") or []):
            if tc.get("function",{}).get("name")=="generateDesign": gen=True
    for a in d.get("uiActions",[]) or []:
        if a.get("name")=="showConfigurator": cfg=True
print("  generateDesign=%s showConcept=%s showConfigurator=%s%s" % (gen,concept,cfg, "" if sys.argv[2]=="1" else "  (retry)"))
sys.exit(0 if gen and cfg else 1)
PY
  doorA_rc=$?
  [ "$attempt" = "2" ] && break
  [ $doorA_rc -eq 0 ] && break
done
[ $doorA_rc -eq 0 ] && ok "chat: generateDesign fired + configurator rendered" || bad "Door A chat wiring incomplete"
fi

# ─────────────────────────────────────────────────────────────────────────────
say "10 · Path A — faithful proof (artwork-heavy design reproduced on our garment)"
if [ "${SKIP_IMAGEGEN:-0}" = "1" ]; then skip "SKIP_IMAGEGEN=1"; else
# The HARD case (not a clean product photo): generate a Rink-Rippers-style all-over
# hockey design, then reproduce it onto our hockey template via the proof engine.
curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/design" -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
  -d '{"brief":"aggressive all-over sublimated hockey jersey, torn ripped grunge pattern in purple green and orange, snarling monster mascot logo on the chest, team name RINK RIPPERS, number 23 on the sleeve, lace-up collar"}' \
  --max-time 120 > "$TMP/rr_design.json"
python3 -c "import json;open('$TMP/rr_art.txt','w').write(json.load(open('$TMP/rr_design.json')).get('concept',''))"
HSKU=$(curl -s "$PRODUCT/api/v1/$PROJECT/cdl/templates?sport=HOCKEY&limit=1" -H "X-Internal-Key: $KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)['templates'][0]['parentSku'])")
python3 -c "import json;print(json.dumps({'sku':'$HSKU','artworkBase64':open('$TMP/rr_art.txt').read()}))" > "$TMP/rr_proof_req.json"
curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/proof" -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
  --data @"$TMP/rr_proof_req.json" --max-time 120 > "$TMP/rr_proof.json"
python3 -c "import json,sys;d=json.load(open('$TMP/rr_proof.json'));print('  proof ok=%s proofId=%s provider=%s'%(d.get('ok'),bool(d.get('proofId')),d.get('provider')));sys.exit(0 if d.get('ok') and d.get('proofId') else 1)"
if [ $? -eq 0 ]; then
  PROOFID=$(python3 -c "import json;print(json.load(open('$TMP/rr_proof.json'))['proofId'])")
  ct=$(curl -s -o "$TMP/proof.png" -w '%{content_type}' "$PRODUCT/api/v1/$PROJECT/cdl/concept/$PROOFID" -H "X-Internal-Key: $KEY" --max-time 20)
  echo "$ct" | grep -q "image/" && ok "artwork-heavy design → faithful proof rendered ($(wc -c < "$TMP/proof.png") bytes)" || bad "proof image not served"
else bad "proof build failed"; fi
fi

# ─────────────────────────────────────────────────────────────────────────────
say "11 · CDL-10 decompose — split a design into clean SEPARATE layers (pattern + logo)"
if [ "${SKIP_IMAGEGEN:-0}" = "1" ]; then skip "SKIP_IMAGEGEN=1"; else
# Reuse the Rink-Rippers design generated in #10 (its conceptId is live in memory).
SRC=$(python3 -c "import json;print(json.load(open('$TMP/rr_design.json')).get('conceptId',''))" 2>/dev/null)
if [ -z "$SRC" ]; then bad "no source conceptId from #10 to decompose"; else
  curl -s -X POST "$PRODUCT/api/v1/$PROJECT/cdl/decompose" -H "Content-Type: application/json" -H "X-Internal-Key: $KEY" \
    -d "{\"sourceId\":\"$SRC\"}" --max-time 150 > "$TMP/decompose.json"
  python3 - "$TMP/decompose.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("  ok=%s patternId=%s logoId=%s" % (d.get("ok"), bool(d.get("patternId")), bool(d.get("logoId"))))
sys.exit(0 if d.get("ok") and d.get("patternId") and d.get("logoId") else 1)
PY
  if [ $? -eq 0 ]; then
    ok "decompose → separate patternId + logoId"
    PAT=$(python3 -c "import json;print(json.load(open('$TMP/decompose.json'))['patternId'])")
    LOGO=$(python3 -c "import json;print(json.load(open('$TMP/decompose.json'))['logoId'])")
    ctp=$(curl -s -o "$TMP/dpattern.png" -w '%{content_type}' "$PRODUCT/api/v1/$PROJECT/cdl/concept/$PAT" -H "X-Internal-Key: $KEY" --max-time 20)
    ctl=$(curl -s -o "$TMP/dlogo.png" -w '%{content_type}' "$PRODUCT/api/v1/$PROJECT/cdl/concept/$LOGO" -H "X-Internal-Key: $KEY" --max-time 20)
    { echo "$ctp" | grep -q "image/" && echo "$ctl" | grep -q "image/"; } \
      && ok "both layers served as images (pattern $(wc -c < "$TMP/dpattern.png")b, logo $(wc -c < "$TMP/dlogo.png")b)" \
      || bad "decomposed layer images not served ($ctp / $ctl)"
  else bad "decompose did not return both layers"; fi
fi
fi

# ─────────────────────────────────────────────────────────────────────────────
say "RESULT"
printf '  PASS=%d  FAIL=%d  SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] && { echo "  ✅ all executed checks passed"; exit 0; } || { echo "  ❌ failures above"; exit 1; }
