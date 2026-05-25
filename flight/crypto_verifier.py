"""
Cryptographic signature verifier component.
Validates Ed25519 signatures on incoming command plans using canonical JSON hashing.
"""

import hashlib
import json
import os
from pathlib import Path
from typing import Dict, List, Any, Optional

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PublicKey,
    Ed25519PrivateKey,
)
from cryptography.exceptions import InvalidSignature

from flight.config import FswConfig


class CryptoVerifier:
    

    def __init__(self, config: Optional[FswConfig] = None):
        
        self._config = config or FswConfig()
        self._trusted_keys: Dict[str, bytes] = {}
        self._load_trusted_keys()

    # Public Interface — ICryptoVerifier

    def verify(self, plan_data: Dict[str, Any]) -> bool:
       
        try:
            commands = plan_data.get("commands", [])
            signature_hex = plan_data.get("signature", "")
            public_key_hex = plan_data.get("public_key", "")

            if not commands or not signature_hex or not public_key_hex:
                return False

            # Check if public key is trusted
            public_key_bytes = bytes.fromhex(public_key_hex)
            if not self.is_trusted_key(public_key_bytes):
                return False

            # Compute canonical hash
            canonical_hash = self.compute_canonical_hash(commands)

            # Verify Ed25519 signature
            signature_bytes = bytes.fromhex(signature_hex)
            public_key = Ed25519PublicKey.from_public_bytes(public_key_bytes)
            public_key.verify(signature_bytes, canonical_hash)

            return True

        except (ValueError, InvalidSignature, Exception):
            return False

    def is_trusted_key(self, public_key_bytes: bytes) -> bool:
     
        key_hex = public_key_bytes.hex()
        return key_hex in self._trusted_keys

    def get_trusted_keys(self) -> List[bytes]:
        
        return [bytes.fromhex(k) for k in self._trusted_keys.keys()]

    def add_trusted_key(self, name: str, public_key_bytes: bytes) -> None:
        
        self._trusted_keys[public_key_bytes.hex()] = name

    def remove_trusted_key(self, public_key_bytes: bytes) -> None:
        """Remove a trusted public key."""
        self._trusted_keys.pop(public_key_bytes.hex(), None)

    # Static Methods - Canonical JSON + Hash

    @staticmethod
    def compute_canonical_hash(commands: List[Dict[str, Any]]) -> bytes:
        
        canonical = json.dumps(commands, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).digest()

    @staticmethod
    def compute_canonical_hash_hex(commands: List[Dict[str, Any]]) -> str:
        """Same as compute_canonical_hash but returns hex string."""
        return CryptoVerifier.compute_canonical_hash(commands).hex()

    # Key Generation (for testing / initial setup)

    @staticmethod
    def generate_keypair() -> tuple:
    
        private_key = Ed25519PrivateKey.generate()
        public_key = private_key.public_key()

        private_bytes = private_key.private_bytes_raw()
        public_bytes = public_key.public_bytes_raw()

        return private_bytes, public_bytes

    @staticmethod
    def sign(commands: List[Dict[str, Any]], private_key_bytes: bytes) -> bytes:
 
        canonical_hash = CryptoVerifier.compute_canonical_hash(commands)
        private_key = Ed25519PrivateKey.from_private_bytes(private_key_bytes)
        return private_key.sign(canonical_hash)

    # Internal - Key Loading

    def _load_trusted_keys(self) -> None:
        key_path = Path(self._config.TRUSTED_KEYS_PATH)

        if not key_path.exists():
            return

        try:
            with open(key_path, "r", encoding="utf-8") as f:
                keys_data = json.loads(f.read())

            for entry in keys_data:
                name = entry.get("name", "unknown")
                key_hex = entry.get("public_key_hex", "")
                if key_hex:
                    self._trusted_keys[key_hex] = name
        except (json.JSONDecodeError, OSError):
            pass
