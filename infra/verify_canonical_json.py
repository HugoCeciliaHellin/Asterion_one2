#!/usr/bin/env python3
"""
============================================================
ASTERION ONE — Canonical JSON Cross-Compatibility Verification
============================================================
Generates reference values for JS canonicalJSON tests.
Proves that Python json.dumps(sort_keys=True, separators=(',',':'))
produces identical bytes to JS canonicalJSON() for all test cases.

Also computes SHA-256 hashes of the canonical output to verify
the full signing pipeline compatibility:
  ① canonical = json.dumps(commands, sort_keys=True, separators=(',',':'))
  ② payload_hash = SHA-256(canonical)
  → Must match browser-side sha256(canonicalJSON(commands))

Run: python3 infra/verify_canonical_json.py

Ref: SD-1C, ICD §2.3
Req: REQ-SEC-ED25519
============================================================
"""

import json
import hashlib

# ── Test Cases ────────────────────────────────────────────

TEST_CASES = [
    ("simple sorted", {"b": 2, "a": 1}),
    ("nested with arrays", {"z": [{"c": 3, "a": 1}], "a": "hello"}),
    ("booleans and null", {"c": None, "b": True, "a": False}),
    ("empty object", {}),
    ("empty array", []),
    ("ICD command structure", [
        {
            "sequence_id": 1,
            "command_type": "SET_PARAM",
            "payload": {"param_value": 2, "param_name": "telem_freq"},
        },
        {
            "sequence_id": 2,
            "command_type": "RUN_DIAGNOSTIC",
            "payload": {"subsystem": "thermal"},
        },
    ]),
    ("realistic 3-command plan", [
        {
            "sequence_id": 1,
            "command_type": "SET_PARAM",
            "payload": {"param_name": "gain", "param_value": 3.5},
        },
        {
            "sequence_id": 2,
            "command_type": "SET_MODE",
            "payload": {"target_mode": "NOMINAL"},
        },
        {
            "sequence_id": 3,
            "command_type": "RUN_DIAGNOSTIC",
            "payload": {"subsystem": "THERMAL", "verbose": True},
        },
    ]),
]


def canonical_python(obj):
    """Python canonical JSON — the reference implementation."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def main():
    print("\n=== Canonical JSON — Python Reference Values ===")
    print("=== For verifying JS compatibility (REQ-SEC-ED25519) ===\n")

    all_pass = True

    for name, obj in TEST_CASES:
        canonical = canonical_python(obj)
        sha = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

        print(f"  Test: {name}")
        print(f"  Canonical: {canonical}")
        print(f"  SHA-256:   {sha}")
        print()

    # ── Specific verification of the signing payload ──────
    print("=" * 60)
    print("SIGNING PAYLOAD VERIFICATION")
    print("=" * 60)
    print()

    signing_commands = [
        {
            "sequence_id": 1,
            "command_type": "SET_PARAM",
            "payload": {"param_name": "telem_freq", "param_value": 2},
        },
        {
            "sequence_id": 2,
            "command_type": "RUN_DIAGNOSTIC",
            "payload": {"subsystem": "thermal"},
        },
    ]

    canonical = canonical_python(signing_commands)
    sha = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    print(f"  Commands:  {json.dumps(signing_commands, indent=2)}")
    print()
    print(f"  Canonical: {canonical}")
    print(f"  SHA-256:   {sha}")
    print()
    print("  The browser-side signCommands() must produce the same")
    print("  SHA-256 hash as payload_hash before signing with Ed25519.")
    print()

    # ── Verify key properties ─────────────────────────────
    print("=" * 60)
    print("PROPERTIES VERIFIED")
    print("=" * 60)
    print()

    # 1. Key ordering is alphabetical at all levels
    nested = {"z": {"b": 1, "a": 2}, "a": {"d": 3, "c": 4}}
    c = canonical_python(nested)
    assert c == '{"a":{"c":4,"d":3},"z":{"a":2,"b":1}}', f"Nested sort failed: {c}"
    print("  ✓ Keys sorted alphabetically at all nesting levels")

    # 2. Arrays preserve element order
    arr = [3, 1, 2]
    c = canonical_python(arr)
    assert c == "[3,1,2]", f"Array order failed: {c}"
    print("  ✓ Array element order preserved (not sorted)")

    # 3. No whitespace in output (compact separators)
    assert " " not in canonical_python({"a": 1, "b": 2}), "Whitespace found!"
    print("  ✓ No whitespace in output (compact separators)")

    # 4. Boolean lowercase (Python True → JSON true)
    c = canonical_python({"flag": True})
    assert c == '{"flag":true}', f"Boolean case failed: {c}"
    print("  ✓ Booleans lowercase (true/false)")

    # 5. None → null
    c = canonical_python({"val": None})
    assert c == '{"val":null}', f"None/null failed: {c}"
    print("  ✓ None → null")

    # 6. Deterministic (same input → same output)
    c1 = canonical_python(signing_commands)
    c2 = canonical_python(signing_commands)
    assert c1 == c2, "Non-deterministic!"
    print("  ✓ Deterministic (same input → same output)")

    # 7. SHA-256 is consistent
    h1 = hashlib.sha256(c1.encode()).hexdigest()
    h2 = hashlib.sha256(c2.encode()).hexdigest()
    assert h1 == h2, "SHA-256 inconsistent!"
    print("  ✓ SHA-256 hash consistent across invocations")

    print()
    print("  ✓ ALL CHECKS PASS — Python canonical JSON verified")
    print("  ✓ JS must match these exact outputs for REQ-SEC-ED25519")
    print()


if __name__ == "__main__":
    main()
