"""
Unit tests for the crypto verifier.
Tests signature validation, canonical JSON hashing, and key management.
"""

import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from flight.crypto_verifier import CryptoVerifier
from flight.config import FswConfig


def make_verifier_with_key():
    """Create a verifier with a trusted keypair for testing."""
    config = FswConfig()
    config.TRUSTED_KEYS_PATH = "/tmp/nonexistent_keys.json"  # No file
    verifier = CryptoVerifier(config=config)

    # Generate and trust a keypair
    priv, pub = CryptoVerifier.generate_keypair()
    verifier.add_trusted_key("test_operator", pub)

    return verifier, priv, pub


def make_commands():
    """Create sample commands for signing."""
    return [
        {"sequence_id": 1, "command_type": "SET_PARAM",
         "payload": {"param_name": "telem_freq", "param_value": 2}},
        {"sequence_id": 2, "command_type": "RUN_DIAGNOSTIC",
         "payload": {"subsystem": "thermal"}},
    ]


def make_plan_data(commands, priv, pub):
    """Create a valid signed plan_data dict."""
    sig = CryptoVerifier.sign(commands, priv)
    return {
        "commands": commands,
        "signature": sig.hex(),
        "public_key": pub.hex(),
    }

def test_valid_signature():
    verifier, priv, pub = make_verifier_with_key()
    commands = make_commands()
    plan_data = make_plan_data(commands, priv, pub)

    assert verifier.verify(plan_data) is True

def test_corrupted_signature():
    verifier, priv, pub = make_verifier_with_key()
    commands = make_commands()
    plan_data = make_plan_data(commands, priv, pub)

    # Corrupt one byte of signature
    sig_bytes = bytes.fromhex(plan_data["signature"])
    corrupted = bytes([sig_bytes[0] ^ 0xFF]) + sig_bytes[1:]
    plan_data["signature"] = corrupted.hex()

    assert verifier.verify(plan_data) is False

def test_unknown_public_key():
    verifier, priv, pub = make_verifier_with_key()
    commands = make_commands()

    # Sign with trusted key but present with different public key
    sig = CryptoVerifier.sign(commands, priv)
    _, unknown_pub = CryptoVerifier.generate_keypair()

    plan_data = {
        "commands": commands,
        "signature": sig.hex(),
        "public_key": unknown_pub.hex(),
    }

    assert verifier.verify(plan_data) is False

def test_tampered_commands():
    verifier, priv, pub = make_verifier_with_key()
    commands = make_commands()
    plan_data = make_plan_data(commands, priv, pub)

    # Tamper with commands after signing
    plan_data["commands"][0]["payload"]["param_value"] = 999

    assert verifier.verify(plan_data) is False

def test_canonical_json_deterministic():
    # Same data, different key order → same hash
    cmd_a = [{"b": 2, "a": 1, "c": 3}]
    cmd_b = [{"a": 1, "c": 3, "b": 2}]

    hash_a = CryptoVerifier.compute_canonical_hash_hex(cmd_a)
    hash_b = CryptoVerifier.compute_canonical_hash_hex(cmd_b)

    assert hash_a == hash_b, "Canonical JSON should be key-order independent"


def test_canonical_json_different_data():
    cmd_a = [{"a": 1}]
    cmd_b = [{"a": 2}]

    hash_a = CryptoVerifier.compute_canonical_hash_hex(cmd_a)
    hash_b = CryptoVerifier.compute_canonical_hash_hex(cmd_b)

    assert hash_a != hash_b, "Different data should produce different hashes"

def test_generate_keypair():
    priv, pub = CryptoVerifier.generate_keypair()
    assert len(priv) == 32, f"Private key should be 32 bytes, got {len(priv)}"
    assert len(pub) == 32, f"Public key should be 32 bytes, got {len(pub)}"

    # Different calls should produce different keys
    priv2, pub2 = CryptoVerifier.generate_keypair()
    assert priv != priv2
    assert pub != pub2

def test_add_remove_trusted_key():
    config = FswConfig()
    config.TRUSTED_KEYS_PATH = "/tmp/nonexistent.json"
    verifier = CryptoVerifier(config=config)

    _, pub = CryptoVerifier.generate_keypair()

    assert verifier.is_trusted_key(pub) is False
    assert len(verifier.get_trusted_keys()) == 0

    verifier.add_trusted_key("op1", pub)
    assert verifier.is_trusted_key(pub) is True
    assert len(verifier.get_trusted_keys()) == 1

    verifier.remove_trusted_key(pub)
    assert verifier.is_trusted_key(pub) is False
    assert len(verifier.get_trusted_keys()) == 0


def test_empty_plan():
    verifier, _, _ = make_verifier_with_key()

    assert verifier.verify({}) is False
    assert verifier.verify({"commands": []}) is False
    assert verifier.verify({"commands": [{"a": 1}]}) is False  # No sig

def test_cross_key_rejection():
    verifier, priv_a, pub_a = make_verifier_with_key()
    priv_b, pub_b = CryptoVerifier.generate_keypair()
    verifier.add_trusted_key("op_b", pub_b)

    commands = make_commands()
    sig_a = CryptoVerifier.sign(commands, priv_a)

    plan_data = {
        "commands": commands,
        "signature": sig_a.hex(),
        "public_key": pub_b.hex(),
    }

    assert verifier.verify(plan_data) is False

def test_sign_verify_roundtrip():
    verifier, priv, pub = make_verifier_with_key()

    test_cases = [
        [{"sequence_id": 1, "command_type": "SET_MODE", "payload": {"mode": "SAFE"}}],
        [{"a": 1}, {"b": 2}, {"c": 3}],
        [{"nested": {"deep": {"value": 42}}}],
    ]

    for commands in test_cases:
        sig = CryptoVerifier.sign(commands, priv)
        plan_data = {
            "commands": commands,
            "signature": sig.hex(),
            "public_key": pub.hex(),
        }
        assert verifier.verify(plan_data) is True, \
            f"Roundtrip failed for {commands}"

def test_canonical_hash_length():
    commands = make_commands()
    h = CryptoVerifier.compute_canonical_hash_hex(commands)
    assert len(h) == 64  # SHA-256 hex = 64 chars

    hb = CryptoVerifier.compute_canonical_hash(commands)
    assert len(hb) == 32  # SHA-256 raw = 32 bytes
