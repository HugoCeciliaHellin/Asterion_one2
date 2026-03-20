#!/usr/bin/env python3
"""
============================================================
ASTERION ONE — fault_injector: inject bad-signature
============================================================
Ref: Art.5 §3.4.2, SD-1B (Invalid Signature Flow)
Req: REQ-SEC-ED25519 — "The satellite must reject and log
     any command with an invalid signature"

Flow:
  1. POST /api/contact-windows → create window
  2. PATCH /api/contact-windows/:id → ACTIVE
  3. POST /api/command-plans → create plan (DRAFT)
  4. PATCH /api/command-plans/:id → sign with CORRUPTED signature
  5. POST /api/command-plans/:id/upload → upload to Flight
  6. Poll GET /api/command-plans/:id → expect status=REJECTED
  7. GET /api/events?severity=CRITICAL → expect ≥2 events
  8. GET /api/commands?plan_id=X → expect 0 EXECUTED

Output: JSON report per Art.5 §3.4.2 output schema
============================================================
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError


# ── Configuration ──────────────────────────────────────────

DEFAULT_API_BASE = "http://localhost:3000/api"
POLL_INTERVAL_S = 0.5
POLL_TIMEOUT_S = 10.0
CORRUPTED_SIGNATURE = "Q09SUlVQVEVEX1NJR05BVFVSRV9GT1JfVEVTVElORw=="  # base64("CORRUPTED_SIGNATURE_FOR_TESTING")
CORRUPTED_PUBLIC_KEY = "Q09SUlVQVEVEX1BVQkxJQ19LRVk="                  # base64("CORRUPTED_PUBLIC_KEY")


# ── HTTP Helpers ───────────────────────────────────────────

def api_request(method, path, body=None, base_url=DEFAULT_API_BASE):
    """Make an HTTP request to the Ground API."""
    url = f"{base_url}{path}"
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib_request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib_request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8")), resp.status
    except HTTPError as e:
        body_text = e.read().decode("utf-8") if e.fp else "{}"
        try:
            return json.loads(body_text), e.code
        except json.JSONDecodeError:
            return {"error": {"code": "UNKNOWN", "message": body_text}}, e.code


def api_get(path, base_url=DEFAULT_API_BASE):
    return api_request("GET", path, base_url=base_url)


def api_post(path, body, base_url=DEFAULT_API_BASE):
    return api_request("POST", path, body, base_url=base_url)


def api_patch(path, body, base_url=DEFAULT_API_BASE):
    return api_request("PATCH", path, body, base_url=base_url)


# ── Injection Logic ────────────────────────────────────────

def inject_bad_signature(api_base=DEFAULT_API_BASE, verbose=True):
    """
    Execute the bad-signature fault injection.

    Returns:
        dict: JSON report with pass/fail result
    """
    report = {
        "injection_type": "bad-signature",
        "injected_at": None,
        "requirement": "REQ-SEC-ED25519",
        "steps": [],
    }

    def log_step(name, success, detail=""):
        step = {"step": name, "success": success, "detail": detail}
        report["steps"].append(step)
        if verbose:
            icon = "✓" if success else "✗"
            print(f"  {icon} {name}: {detail}")
        return success

    if verbose:
        print("\n=== fault_injector: inject bad-signature ===")
        print(f"Target: {api_base}")
        print()

    # ── STEP 1: Create contact window ────────────────────
    now = datetime.now(timezone.utc)
    window_data = {
        "name": f"FI-BadSig-{now.strftime('%H%M%S')}",
        "aos_time": (now + timedelta(seconds=-30)).isoformat(),
        "los_time": (now + timedelta(minutes=10)).isoformat(),
    }
    resp, status = api_post("/contact-windows", window_data, api_base)
    if status != 201:
        log_step("Create window", False, f"HTTP {status}: {resp}")
        return _finalize_report(report, False)

    window_id = resp["data"]["id"]
    log_step("Create contact window", True, f"id={window_id[:8]}")

    # ── STEP 2: Activate window ──────────────────────────
    resp, status = api_patch(f"/contact-windows/{window_id}", {"status": "ACTIVE"}, api_base)
    if status != 200:
        log_step("Activate window", False, f"HTTP {status}: {resp}")
        return _finalize_report(report, False)

    log_step("Activate window", True, "SCHEDULED → ACTIVE")

    # ── STEP 3: Create command plan ──────────────────────
    plan_data = {
        "contact_window_id": window_id,
        "operator_name": "fault_injector",
        "commands": [
            {"command_type": "SET_PARAM", "payload": {"param_name": "test", "param_value": 1}},
            {"command_type": "RUN_DIAGNOSTIC", "payload": {"subsystem": "THERMAL"}},
        ],
    }
    resp, status = api_post("/command-plans", plan_data, api_base)
    if status != 201:
        log_step("Create plan", False, f"HTTP {status}: {resp}")
        return _finalize_report(report, False)

    plan_id = resp["data"]["id"]
    cmd_count = len(resp["data"].get("commands", []))
    log_step("Create command plan", True, f"id={plan_id[:8]}, {cmd_count} commands")

    # ── STEP 4: Sign with CORRUPTED signature ────────────
    sign_data = {
        "signature": CORRUPTED_SIGNATURE,
        "signature_algo": "Ed25519",
        "public_key": CORRUPTED_PUBLIC_KEY,
    }
    resp, status = api_patch(f"/command-plans/{plan_id}", sign_data, api_base)
    if status != 200:
        log_step("Sign with bad signature", False, f"HTTP {status}: {resp}")
        return _finalize_report(report, False)

    log_step("Sign with CORRUPTED signature", True,
             f"sig={CORRUPTED_SIGNATURE[:20]}...")

    # ── STEP 5: Upload to Flight ─────────────────────────
    report["injected_at"] = datetime.now(timezone.utc).isoformat()

    resp, status = api_post(
        f"/command-plans/{plan_id}/upload",
        {"public_key": CORRUPTED_PUBLIC_KEY},
        api_base
    )

    # Upload may succeed (202) — the rejection happens on the Flight side
    # Or fail with 503 if Flight not connected
    if status == 503:
        log_step("Upload to Flight", False,
                 "FLIGHT_DISCONNECTED — Flight Segment must be running for this test")
        return _finalize_report(report, False)
    elif status == 202:
        log_step("Upload to Flight", True, "UPLOADED — awaiting Flight NACK")
    else:
        log_step("Upload to Flight", False, f"HTTP {status}: {resp}")
        return _finalize_report(report, False)

    # ── STEP 6: Poll for REJECTED status ─────────────────
    start_poll = time.time()
    plan_status = "UPLOADED"

    while time.time() - start_poll < POLL_TIMEOUT_S:
        resp, status = api_get(f"/command-plans/{plan_id}", api_base)
        if status == 200:
            plan_status = resp["data"]["status"]
            if plan_status in ("REJECTED", "COMPLETED"):
                break
        time.sleep(POLL_INTERVAL_S)

    poll_time_ms = (time.time() - start_poll) * 1000
    plan_rejected = plan_status == "REJECTED"
    log_step(
        "Plan REJECTED by Flight",
        plan_rejected,
        f"status={plan_status}, poll_time={poll_time_ms:.0f}ms"
    )

    # ── STEP 7: Verify 0 commands EXECUTED ───────────────
    resp, status = api_get(f"/commands?plan_id={plan_id}", api_base)
    commands_data = resp.get("data", []) if status == 200 else []
    executed_count = sum(1 for c in commands_data if c["status"] == "EXECUTED")
    failed_count = sum(1 for c in commands_data if c["status"] == "FAILED")

    zero_executed = executed_count == 0
    log_step(
        "0 commands EXECUTED",
        zero_executed,
        f"executed={executed_count}, failed={failed_count}, total={len(commands_data)}"
    )

    # ── STEP 8: Verify ≥2 CRITICAL audit events ─────────
    resp, status = api_get("/events?severity=CRITICAL&limit=50", api_base)
    critical_events = resp.get("data", []) if status == 200 else []

    # Filter for events related to this plan
    plan_critical = [
        e for e in critical_events
        if plan_id[:8] in (e.get("description", "") + json.dumps(e.get("metadata", {})))
        or e.get("event_type") in ("COMMAND_REJECTED", "SIGNATURE_INVALID")
    ]

    has_critical = len(plan_critical) >= 2
    event_types = [e["event_type"] for e in plan_critical]
    log_step(
        "≥2 CRITICAL events logged",
        has_critical,
        f"found={len(plan_critical)}, types={event_types}"
    )

    # ── STEP 9: Verify hash-chain integrity ──────────────
    resp, status = api_get("/events/verify", api_base)
    chain_valid = False
    if status == 200:
        chain_valid = resp.get("data", {}).get("chain_valid", False)

    log_step("Audit chain intact", chain_valid,
             f"chain_valid={chain_valid}")

    # ── Finalize ─────────────────────────────────────────
    all_pass = plan_rejected and zero_executed and has_critical and chain_valid

    report["plan_id"] = plan_id
    report["plan_status"] = plan_status
    report["commands_executed"] = executed_count
    report["commands_failed"] = failed_count
    report["critical_events_count"] = len(plan_critical)
    report["critical_event_types"] = event_types
    report["chain_valid"] = chain_valid

    return _finalize_report(report, all_pass)


def _finalize_report(report, passed):
    """Add final pass/fail to report and return."""
    report["completed_at"] = datetime.now(timezone.utc).isoformat()
    report["pass"] = passed

    return report


# ── CLI Entry Point ────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Asterion One — Fault Injector: inject bad-signature"
    )
    parser.add_argument(
        "--api-base", default=DEFAULT_API_BASE,
        help=f"Ground API base URL (default: {DEFAULT_API_BASE})"
    )
    parser.add_argument(
        "--quiet", action="store_true",
        help="Suppress step-by-step output, only print JSON report"
    )

    args = parser.parse_args()
    verbose = not args.quiet

    try:
        report = inject_bad_signature(api_base=args.api_base, verbose=verbose)
    except (ConnectionError, URLError) as e:
        report = {
            "injection_type": "bad-signature",
            "pass": False,
            "error": f"Cannot connect to API: {e}",
        }
        if verbose:
            print(f"\n✗ FAILED: Cannot connect to Ground API at {args.api_base}")
            print(f"  Ensure the API server is running: cd ground && npm start")

    # Print JSON report
    if verbose:
        print()
    print(json.dumps(report, indent=2))

    # Exit code: 0 = pass, 1 = fail
    sys.exit(0 if report.get("pass") else 1)


if __name__ == "__main__":
    main()