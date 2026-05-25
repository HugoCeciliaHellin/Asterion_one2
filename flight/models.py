"""
Canonical data models for the flight segment.
Uses dataclasses to define shared contracts between components, ensuring 
type-safe interoperability across the flight software.
"""
from enum import Enum
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List


# Enums

class FswState(str, Enum):

    BOOT     = "BOOT"
    NOMINAL  = "NOMINAL"
    SAFE     = "SAFE"
    CRITICAL = "CRITICAL"


class Severity(str, Enum):
    
    INFO     = "INFO"
    WARNING  = "WARNING"
    CRITICAL = "CRITICAL"


class CommandStatus(str, Enum):
    
    QUEUED   = "QUEUED"
    SENT     = "SENT"
    EXECUTED = "EXECUTED"
    FAILED   = "FAILED"
    REJECTED = "REJECTED"
    EXPIRED  = "EXPIRED"


class PlanStatus(str, Enum):
    
    DRAFT     = "DRAFT"
    SIGNED    = "SIGNED"
    UPLOADED  = "UPLOADED"
    COMPLETED = "COMPLETED"
    REJECTED  = "REJECTED"


class WindowStatus(str, Enum):
    
    SCHEDULED = "SCHEDULED"
    ACTIVE    = "ACTIVE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


# Telemetry

@dataclass
class TelemetryFrame:
    
    seq_id: int
    timestamp: datetime
    fsw_state: FswState
    subsystems: Dict[str, Dict[str, float]]


# Commands

@dataclass
class Command:

    sequence_id: int
    command_type: str
    payload: Dict[str, Any]


@dataclass
class CommandPlan:
    
    plan_id: str
    commands: List[Command]
    signature: bytes
    signature_algo: str = "Ed25519"
    public_key: bytes = b""


@dataclass
class PlanResult:
   
    status: str          # "COMPLETED" | "REJECTED"
    reason: Optional[str] = None


@dataclass
class CmdResult:
    
    sequence_id: int
    status: str          # "EXECUTED" | "FAILED"
    executed_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


# Audit

@dataclass
class AuditEntry:
   
    timestamp: datetime
    event_type: str
    source: str
    severity: Severity
    description: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    hash: str = ""
    prev_hash: str = ""


@dataclass
class ChainVerificationResult:
    
    chain_valid: bool
    total_events: int
    break_at_index: Optional[int] = None
    expected_hash: Optional[str] = None
    actual_hash: Optional[str] = None


# WebSocket Messages

@dataclass
class WsMessage:
 
    type: str
    seq_id: int
    timestamp: datetime
    payload: Dict[str, Any]


# Digital Twin (used in Fase 4, defined here for completeness)

@dataclass
class Forecast:
    model_type: str               # "THERMAL" | "ENERGY"
    horizon_min: int              # Forecast horizon in minutes
    predicted_values: Dict[str, float]  # {minute_offset: predicted_value}
    breach_detected: bool = False
    breach_time: Optional[datetime] = None
    lead_time_min: Optional[float] = None
    rationale: Optional[str] = None
    alert_emitted: bool = False
