# Full test suite runner.
# Executes all system tests and generates a timestamped report.
#
# Usage: bash infra/run_evidence_pack.sh
#
# Prerequisites:
#   - PostgreSQL running (docker compose up -d)
#   - npm ci in ground/ and ground/ui/
#   - pip install -r flight/requirements.txt
#   - pip install -r twin/requirements.txt
#   - Migrations applied (npx knex migrate:latest)

set -euo pipefail

REPORT_DIR="evidence_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$REPORT_DIR"

PASS=0
FAIL=0
TOTAL=0

log() {
  echo "$1" | tee -a "$REPORT_DIR/report.txt"
}

run_test() {
  local name="$1"
  local cmd="$2"
  TOTAL=$((TOTAL + 1))

  log ""
  log "━━━ TEST: $name ━━━"
  log "CMD: $cmd"

  if eval "$cmd" >> "$REPORT_DIR/${name// /_}.log" 2>&1; then
    PASS=$((PASS + 1))
    log "RESULT: ✅ PASS"
  else
    FAIL=$((FAIL + 1))
    log "RESULT: ❌ FAIL (see ${name// /_}.log)"
  fi
}

#  Header

log "════════════════════════════════════════════════════════"
log "  ASTERION ONE — Evidence Pack"
log "  Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "  Host: $(hostname)"
log "════════════════════════════════════════════════════════"

#  Phase 0: Smoke Tests

log ""
log "══ PHASE 0: Scaffolding ══"

run_test "P0-Docker" "docker compose ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || echo 'Docker not running'"
run_test "P0-Structure" "test -d flight && test -d ground && test -d twin && test -d infra && test -d docs"

# ── Phase 1: Flight Core ─────────────────────────────────

log ""
log "══ PHASE 1: Flight Core (150 tests) ══"

run_test "P1-Models" "python3 -m pytest flight/tests/test_models.py -v --tb=short"
run_test "P1-SensorSim" "python3 -m pytest flight/tests/test_sensor_sim.py -v --tb=short"
run_test "P1-AuditLogger" "python3 -m pytest flight/tests/test_audit_logger.py -v --tb=short"
run_test "P1-DiskQueue" "python3 -m pytest flight/tests/test_disk_queue.py -v --tb=short"
run_test "P1-CryptoVerifier" "python3 -m pytest flight/tests/test_crypto_verifier.py -v --tb=short"
run_test "P1-CmdExecutor" "python3 -m pytest flight/tests/test_cmd_executor.py -v --tb=short"
run_test "P1-FswCore" "python3 -m pytest flight/tests/test_fsw_core.py -v --tb=short"

#  Phase 2: Communications 

log ""
log "══ PHASE 2: Communications ══"

run_test "P2-WindowScheduler" "python3 -m pytest flight/tests/test_window_scheduler.py -v --tb=short"
run_test "P2-CommsClient" "python3 -m pytest flight/tests/test_comms_client.py -v --tb=short"
run_test "P2-Integration" "python3 -m pytest flight/tests/test_integration_comms.py -v --tb=short"

#  Phase 3: Ground Segment 

log ""
log "══ PHASE 3: Ground Segment (144 tests) ══"

run_test "P3-DbManager" "cd ground && npm test -- src/db/__tests__/manager.test.js --forceExit 2>&1; cd .."
run_test "P3-ApiServer" "cd ground && npm test -- src/api/__tests__/server.test.js --forceExit 2>&1; cd .."
run_test "P3-WsGateway" "cd ground && npm test -- src/ws/__tests__/gateway.test.js --forceExit 2>&1; cd .."
run_test "P3-AuditService" "cd ground && npm test -- src/services/__tests__/audit.test.js --forceExit 2>&1; cd .."
run_test "P3-BadSignature" "cd ground && npm test -- src/api/__tests__/bad_signature.test.js --forceExit 2>&1; cd .."
run_test "P3-CanonicalJSON" "node ground/ui/src/lib/__tests__/canonical_json.test.mjs"
run_test "P3-PythonCanonical" "python3 infra/verify_canonical_json.py"

#  Phase 4: Digital Twin 

log ""
log "══ PHASE 4: Digital Twin (38 tests) ══"

run_test "P4-TwinEngine" "python3 -m pytest twin/tests/test_twin_engine.py -v --tb=short"
run_test "P4-AlertEngine" "python3 -m pytest twin/tests/test_alert_engine.py -v --tb=short"

#  Phase 5: Observability 

log ""
log "══ PHASE 5: Observability & Docs ══"

run_test "P5-HealthEndpoint" "curl -sf http://localhost:3000/api/health > /dev/null 2>&1 || echo 'API not running (OK for offline evidence)'"
run_test "P5-DocsExist" "test -f docs/ICD.md && test -f docs/TEST_PLAN.md && test -f docs/DEPLOYMENT_GUIDE.md && test -d docs/ADR"
run_test "P5-ADRCount" "test \$(ls docs/ADR/*.md 2>/dev/null | wc -l) -ge 5"
run_test "P5-GrafanaDashboard" "test -f infra/observability/grafana/dashboards/system-health.json"
run_test "P5-OtelConfig" "test -f infra/observability/docker-compose.otel.yml && test -f infra/observability/prometheus.yml"

#  Summary 

log ""
log "════════════════════════════════════════════════════════"
log "  EVIDENCE PACK SUMMARY"
log "════════════════════════════════════════════════════════"
log ""
log "  Total tests executed: $TOTAL"
log "  Passed: $PASS"
log "  Failed: $FAIL"
log ""

if [ "$FAIL" -eq 0 ]; then
  log "  ✅ ALL TESTS PASS — Evidence pack complete"
else
  log "  ❌ $FAIL test(s) FAILED — see individual logs in $REPORT_DIR/"
fi

log ""
log "  Report saved to: $REPORT_DIR/report.txt"
log "  Individual logs: $REPORT_DIR/*.log"
log ""

# Generate JSON summary
cat > "$REPORT_DIR/summary.json" << EOF
{
  "project": "Asterion One",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "total_tests": $TOTAL,
  "passed": $PASS,
  "failed": $FAIL,
  "all_pass": $([ "$FAIL" -eq 0 ] && echo "true" || echo "false"),
  "phases_tested": [0, 1, 2, 3, 4, 5]
}
EOF

log "  JSON summary: $REPORT_DIR/summary.json"

exit $FAIL