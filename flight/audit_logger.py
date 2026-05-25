"""
Cryptographic audit logger component.
Implements an append-only, tamper-evident hash chain for recording system events.
"""

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Dict, Any

from flight.models import AuditEntry, ChainVerificationResult, Severity


class AuditLogger:
    

    # The "prev_hash" value for the very first entry in the chain
    GENESIS_HASH = "GENESIS"

    def __init__(self, log_path: str, source: str = "FLIGHT"):
        
        self._log_path = Path(log_path)
        self._source = source
        self._lock = threading.Lock()

        # Ensure parent directory exists
        self._log_path.parent.mkdir(parents=True, exist_ok=True)

        # Load the last hash from existing log (or GENESIS if empty/new)
        self._prev_hash = self._load_last_hash()

    # Public Interface - IAuditLog

    def log(
        self,
        event_type: str,
        severity: Severity,
        description: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> AuditEntry:
        metadata = metadata or {}
        timestamp = datetime.now(timezone.utc)

        with self._lock:
            # Compute hash: SHA256(prev_hash|timestamp|event_type|source|description)
            hash_input = (
                f"{self._prev_hash}|"
                f"{timestamp.isoformat()}|"
                f"{event_type}|"
                f"{self._source}|"
                f"{description}"
            )
            entry_hash = hashlib.sha256(hash_input.encode("utf-8")).hexdigest()

            # Create the entry
            entry = AuditEntry(
                timestamp=timestamp,
                event_type=event_type,
                source=self._source,
                severity=severity,
                description=description,
                metadata=metadata,
                hash=entry_hash,
                prev_hash=self._prev_hash,
            )

            # Append to file (atomic-ish: single write + flush)
            self._append_to_file(entry)

            # Update chain pointer
            self._prev_hash = entry_hash

            return entry

    def verify_chain(self) -> ChainVerificationResult:
        entries = self._read_all_entries()

        if len(entries) == 0:
            return ChainVerificationResult(
                chain_valid=True,
                total_events=0,
            )

        prev_hash = self.GENESIS_HASH

        for i, entry in enumerate(entries):
            # Check prev_hash linkage
            if entry.prev_hash != prev_hash:
                return ChainVerificationResult(
                    chain_valid=False,
                    total_events=len(entries),
                    break_at_index=i,
                    expected_hash=prev_hash,
                    actual_hash=entry.prev_hash,
                )

            # Recompute hash
            hash_input = (
                f"{entry.prev_hash}|"
                f"{entry.timestamp.isoformat()}|"
                f"{entry.event_type}|"
                f"{entry.source}|"
                f"{entry.description}"
            )
            expected = hashlib.sha256(hash_input.encode("utf-8")).hexdigest()

            if entry.hash != expected:
                return ChainVerificationResult(
                    chain_valid=False,
                    total_events=len(entries),
                    break_at_index=i,
                    expected_hash=expected,
                    actual_hash=entry.hash,
                )

            prev_hash = entry.hash

        return ChainVerificationResult(
            chain_valid=True,
            total_events=len(entries),
        )

    def get_entries(
        self, since: Optional[datetime] = None
    ) -> List[AuditEntry]:
        
        entries = self._read_all_entries()

        if since is not None:
            # Ensure timezone-aware comparison
            if since.tzinfo is None:
                since = since.replace(tzinfo=timezone.utc)
            entries = [e for e in entries if e.timestamp >= since]

        return entries

    @property
    def last_hash(self) -> str:
        with self._lock:
            return self._prev_hash

    @property
    def entry_count(self) -> int:
        return len(self._read_all_entries())

    # Internal — File I/O

    def _append_to_file(self, entry: AuditEntry) -> None:
        record = {
            "timestamp": entry.timestamp.isoformat(),
            "event_type": entry.event_type,
            "source": entry.source,
            "severity": entry.severity.value,
            "description": entry.description,
            "metadata": entry.metadata,
            "hash": entry.hash,
            "prev_hash": entry.prev_hash,
        }
        line = json.dumps(record, separators=(",", ":")) + "\n"

        with open(self._log_path, "a", encoding="utf-8") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())

    def _read_all_entries(self) -> List[AuditEntry]:
        entries = []

        if not self._log_path.exists():
            return entries

        with open(self._log_path, "r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    entry = AuditEntry(
                        timestamp=datetime.fromisoformat(record["timestamp"]),
                        event_type=record["event_type"],
                        source=record["source"],
                        severity=Severity(record["severity"]),
                        description=record["description"],
                        metadata=record.get("metadata", {}),
                        hash=record["hash"],
                        prev_hash=record["prev_hash"],
                    )
                    entries.append(entry)
                except (json.JSONDecodeError, KeyError, ValueError) as e:
                    # Corrupted line - skip but could log warning
                    pass

        return entries

    def _load_last_hash(self) -> str:
        entries = self._read_all_entries()
        if entries:
            return entries[-1].hash
        return self.GENESIS_HASH
