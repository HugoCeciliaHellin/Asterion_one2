"""
Command executor component.
Validates Ed25519 signatures, enforces NOMINAL state restrictions, and executes ground command plans.
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Callable

from flight.models import (
    FswState, Severity, PlanResult, CmdResult,
)
from flight.crypto_verifier import CryptoVerifier
from flight.audit_logger import AuditLogger


class CmdExecutor:
   
    def __init__(
        self,
        crypto: CryptoVerifier,
        audit: AuditLogger,
        command_handlers: Optional[Dict[str, Callable]] = None,
    ):
        self._crypto = crypto
        self._audit = audit
        self._handlers = command_handlers or {}

    # Public Interface - ICommandExecution

    def execute_plan(
        self,
        plan_data: Dict[str, Any],
        fsw_state: FswState,
    ) -> PlanResult:
        plan_id = plan_data.get("plan_id", "unknown")
        commands = plan_data.get("commands", [])

        # Log receipt 
        self._audit.log(
            event_type="PLAN_RECEIVED",
            severity=Severity.INFO,
            description=f"Plan {plan_id}: {len(commands)} commands received",
            metadata={"plan_id": plan_id, "command_count": len(commands)},
        )

        # Gate 1: State check 
        if fsw_state != FswState.NOMINAL:
            reason = "NOT_IN_NOMINAL"
            self._audit.log(
                event_type="COMMAND_REJECTED",
                severity=Severity.CRITICAL,
                description=(
                    f"Plan {plan_id} rejected: FSW state is "
                    f"{fsw_state.value}, not NOMINAL"
                ),
                metadata={
                    "plan_id": plan_id,
                    "reason": reason,
                    "fsw_state": fsw_state.value,
                },
            )
            return PlanResult(status="REJECTED", reason=reason)

        # Gate 2: Signature verification 
        public_key_hex = plan_data.get("public_key", "")

        # Check if key is trusted first (separate NACK reason)
        try:
            public_key_bytes = bytes.fromhex(public_key_hex)
            key_trusted = self._crypto.is_trusted_key(public_key_bytes)
        except ValueError:
            key_trusted = False

        if not key_trusted:
            reason = "UNKNOWN_KEY"
            self._audit.log(
                event_type="SIGNATURE_INVALID",
                severity=Severity.CRITICAL,
                description=(
                    f"Plan {plan_id} rejected: public key not in "
                    f"trusted keys list"
                ),
                metadata={
                    "plan_id": plan_id,
                    "reason": reason,
                    "public_key": public_key_hex[:16] + "...",
                },
            )
            self._audit.log(
                event_type="COMMAND_REJECTED",
                severity=Severity.CRITICAL,
                description=f"Plan {plan_id} rejected: untrusted key",
                metadata={"plan_id": plan_id, "reason": reason},
            )
            return PlanResult(status="REJECTED", reason=reason)

        sig_valid = self._crypto.verify(plan_data)

        if not sig_valid:
            reason = "SIG_INVALID"
            self._audit.log(
                event_type="SIGNATURE_INVALID",
                severity=Severity.CRITICAL,
                description=(
                    f"Plan {plan_id} rejected: Ed25519 signature "
                    f"verification failed"
                ),
                metadata={"plan_id": plan_id, "reason": reason},
            )
            self._audit.log(
                event_type="COMMAND_REJECTED",
                severity=Severity.CRITICAL,
                description=f"Plan {plan_id} rejected: invalid signature",
                metadata={"plan_id": plan_id, "reason": reason},
            )
            return PlanResult(status="REJECTED", reason=reason)

        # Execute commands sequentially 
        results: List[CmdResult] = []

        for cmd in commands:
            result = self.execute_single(cmd, plan_id)
            results.append(result)

            if result.status == "FAILED":
                # Stop execution on first failure
                self._audit.log(
                    event_type="COMMAND_REJECTED",
                    severity=Severity.CRITICAL,
                    description=(
                        f"Plan {plan_id} aborted: command "
                        f"seq={cmd.get('sequence_id', '?')} failed"
                    ),
                    metadata={
                        "plan_id": plan_id,
                        "reason": "EXECUTION_ERROR",
                        "failed_at_seq": cmd.get("sequence_id"),
                    },
                )
                return PlanResult(status="REJECTED", reason="EXECUTION_ERROR")

        self._audit.log(
            event_type="PLAN_COMPLETED",
            severity=Severity.INFO,
            description=(
                f"Plan {plan_id}: all {len(commands)} commands "
                f"executed successfully"
            ),
            metadata={
                "plan_id": plan_id,
                "commands_executed": len(results),
            },
        )

        return PlanResult(status="COMPLETED")

    def execute_single(
        self,
        command: Dict[str, Any],
        plan_id: str = "direct",
    ) -> CmdResult:
        
        seq_id = command.get("sequence_id", 0)
        cmd_type = command.get("command_type", "UNKNOWN")
        payload = command.get("payload", {})
        executed_at = datetime.now(timezone.utc)

        try:
            # Dispatch to handler if registered
            handler = self._handlers.get(cmd_type)
            if handler:
                handler(payload)

            # Log success
            self._audit.log(
                event_type="COMMAND_EXECUTED",
                severity=Severity.INFO,
                description=(
                    f"Command seq={seq_id} type={cmd_type} executed"
                ),
                metadata={
                    "plan_id": plan_id,
                    "sequence_id": seq_id,
                    "command_type": cmd_type,
                    "executed_at": executed_at.isoformat(),
                },
            )

            return CmdResult(
                sequence_id=seq_id,
                status="EXECUTED",
                executed_at=executed_at,
            )

        except Exception as e:
            self._audit.log(
                event_type="COMMAND_FAILED",
                severity=Severity.CRITICAL,
                description=(
                    f"Command seq={seq_id} type={cmd_type} failed: {e}"
                ),
                metadata={
                    "plan_id": plan_id,
                    "sequence_id": seq_id,
                    "command_type": cmd_type,
                    "error": str(e),
                },
            )

            return CmdResult(
                sequence_id=seq_id,
                status="FAILED",
                executed_at=executed_at,
            )

    # Handler Management

    def register_handler(
        self, command_type: str, handler: Callable
    ) -> None:
        self._handlers[command_type] = handler

    def unregister_handler(self, command_type: str) -> None:
        self._handlers.pop(command_type, None)
