"""Sync state persistence for tracking last sync times.

Persists sync state to a JSON file to avoid re-processing
already synced items after worker restarts.
"""

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import structlog

from skald_worker.config import settings

logger = structlog.get_logger(__name__)


class SyncStateCorruptionError(RuntimeError):
    """Raised when durable sync state exists but cannot be safely loaded."""
def _rfc3339_millis(value: datetime | None = None) -> str:
    timestamp = value or datetime.now(UTC)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    return timestamp.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class SourceSyncState:
    """Sync state for a single source."""

    last_sync_time: str | None = None
    last_successful_sync: str | None = None
    items_processed: int = 0
    items_failed: int = 0
    last_error: str | None = None
    cursor: str | None = None  # For pagination-based sync
    metadata: dict[str, Any] = field(default_factory=dict)
    authoritative_snapshot: tuple[str, ...] = ()
    pending_snapshot: tuple[str, ...] = ()
    reconciliation_run_id: str | None = None
    reconciliation_complete: bool = False
    absence_generation: int = 0
    reconciliation_manifest: dict[str, Any] = field(default_factory=dict)
    absence_evidence: dict[str, dict[str, Any]] = field(default_factory=dict)
    tombstone_ready: dict[str, dict[str, Any]] = field(default_factory=dict)
    authoritative_locators: dict[str, str] = field(default_factory=dict)
    pending_locators: dict[str, str] = field(default_factory=dict)


@dataclass
class SyncState:
    """Overall sync state containing all sources."""

    version: str = "1.0"
    sources: dict[str, SourceSyncState] = field(default_factory=dict)
    created_at: str = field(default_factory=_rfc3339_millis)
    updated_at: str = field(default_factory=_rfc3339_millis)

    def get_source(self, source_name: str) -> SourceSyncState:
        """Get or create sync state for a source."""
        if source_name not in self.sources:
            self.sources[source_name] = SourceSyncState()
        return self.sources[source_name]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "version": self.version,
            "sources": {name: asdict(state) for name, state in self.sources.items()},
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SyncState":
        """Create from dictionary."""
        sources = {}
        for name, state_data in data.get("sources", {}).items():
            normalized_state = dict(state_data)
            normalized_state["authoritative_snapshot"] = tuple(normalized_state.get("authoritative_snapshot", ()))
            normalized_state["pending_snapshot"] = tuple(normalized_state.get("pending_snapshot", ()))
            sources[name] = SourceSyncState(**normalized_state)

        return cls(
            version=data.get("version", "1.0"),
            sources=sources,
            created_at=data.get("created_at", _rfc3339_millis()),
            updated_at=data.get("updated_at", _rfc3339_millis()),
        )


class SyncStateManager:
    """Manages persistence of sync state to disk."""

    def __init__(self, state_file: str | None = None):
        self.state_file = Path(state_file or settings.sync_state_file)
        self._state: SyncState | None = None
        self._dirty = False

    @property
    def state(self) -> SyncState:
        """Get current sync state, loading from file if needed."""
        if self._state is None:
            self._state = self._load()
        return self._state

    def _load(self) -> SyncState:
        """Load sync state from file, failing closed when durable evidence is corrupt."""
        if not self.state_file.exists():
            logger.info("No sync state file found, starting fresh", path=str(self.state_file))
            return SyncState()

        try:
            with open(self.state_file) as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise TypeError("sync state root must be an object")
            state = SyncState.from_dict(data)
        except Exception as exc:
            logger.error(
                "Failed to load durable sync state",
                path=str(self.state_file),
                error=str(exc),
            )
            raise SyncStateCorruptionError(f"Corrupt sync state at {self.state_file}: {exc}") from exc

        logger.info(
            "Loaded sync state",
            path=str(self.state_file),
            sources=list(state.sources.keys()),
        )
        return state

    def save(self) -> None:
        """Save sync state to file."""
        if self._state is None:
            return

        self._state.updated_at = _rfc3339_millis()

        try:
            self.state_file.parent.mkdir(mode=0o770, parents=True, exist_ok=True)

            # Keep the temporary file on the same volume so os.replace remains atomic.
            descriptor, temp_name = tempfile.mkstemp(
                dir=self.state_file.parent,
                prefix=f".{self.state_file.name}.",
                suffix=".tmp",
            )
            temp_file = Path(temp_name)
            try:
                os.fchmod(descriptor, 0o660)
                with os.fdopen(descriptor, "w") as file_handle:
                    descriptor = -1
                    json.dump(self._state.to_dict(), file_handle, indent=2)
                    file_handle.flush()
                    os.fsync(file_handle.fileno())
                os.replace(temp_file, self.state_file)
                directory_fd = os.open(self.state_file.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            finally:
                if descriptor >= 0:
                    os.close(descriptor)
                temp_file.unlink(missing_ok=True)
            self._dirty = False
            logger.debug("Saved sync state", path=str(self.state_file))

        except OSError as e:
            logger.error("Failed to save sync state", path=str(self.state_file), error=str(e))
            raise

    def get_last_sync_time(self, source: str) -> datetime | None:
        """Get the last sync time for a source.

        Args:
            source: Source name (e.g., 'jira', 'docs')

        Returns:
            Last sync datetime or None if never synced
        """
        source_state = self.state.get_source(source)
        if source_state.last_successful_sync:
            try:
                return datetime.fromisoformat(source_state.last_successful_sync.rstrip("Z"))
            except ValueError:
                return None
        return None

    def get_cursor(self, source: str) -> str | None:
        """Get pagination cursor for a source."""
        return self.state.get_source(source).cursor

    def record_sync_start(self, source: str) -> None:
        """Record that a sync has started.

        Args:
            source: Source name
        """
        source_state = self.state.get_source(source)
        source_state.last_sync_time = _rfc3339_millis()
        self._dirty = True

    def record_sync_success(
        self,
        source: str,
        items_processed: int,
        items_failed: int = 0,
        cursor: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Record a successful sync.

        Args:
            source: Source name
            items_processed: Number of items processed
            items_failed: Number of items that failed
            cursor: Optional pagination cursor for next sync
            metadata: Optional additional metadata
        """
        source_state = self.state.get_source(source)
        now = _rfc3339_millis()

        source_state.last_successful_sync = now
        source_state.items_processed = items_processed
        source_state.items_failed = items_failed
        source_state.last_error = None
        source_state.cursor = cursor

        if metadata:
            source_state.metadata.update(metadata)

        self._dirty = True
        self.save()

        logger.info(
            "Recorded sync success",
            source=source,
            items_processed=items_processed,
            items_failed=items_failed,
        )

    def record_sync_failure(self, source: str, error: str) -> None:
        """Record a failed sync.

        Args:
            source: Source name
            error: Error message
        """
        source_state = self.state.get_source(source)
        source_state.last_error = error
        source_state.last_sync_time = _rfc3339_millis()

        self._dirty = True
        self.save()

        logger.warning("Recorded sync failure", source=source, error=error)

    def clear_cursor(self, source: str) -> None:
        """Clear pagination cursor for a source (for full resync)."""
        source_state = self.state.get_source(source)
        source_state.cursor = None
        self._dirty = True
        self.save()

    def begin_authoritative_reconciliation(self, source: str, run_id: str) -> None:
        """Start collecting a candidate authoritative source snapshot."""
        source_state = self.state.get_source(source)
        source_state.pending_snapshot = ()
        source_state.pending_locators = {}
        source_state.reconciliation_run_id = run_id
        source_state.reconciliation_complete = False
        self._dirty = True
        self.save()

    def record_authoritative_presence(
        self,
        source: str,
        source_key: str,
        locator: str | None = None,
    ) -> None:
        """Record a source identity observed during the active reconciliation run."""
        source_state = self.state.get_source(source)
        if not source_state.reconciliation_run_id:
            raise ValueError(f"No authoritative reconciliation is active for {source}")
        source_state.pending_snapshot = tuple(sorted({*source_state.pending_snapshot, source_key}))
        if locator:
            source_state.pending_locators[source_key] = locator
        self._dirty = True
        self.save()

    def update_reconciliation_manifest(self, source: str, manifest: dict[str, Any]) -> None:
        """Persist resumable enumeration evidence for the active run."""
        source_state = self.state.get_source(source)
        if not source_state.reconciliation_run_id:
            raise ValueError(f"No authoritative reconciliation is active for {source}")
        source_state.reconciliation_manifest = manifest
        self._dirty = True
        self.save()

    def record_tombstone_refetch(
        self,
        source: str,
        source_key: str,
        *,
        status: str,
        checked_at: str,
    ) -> None:
        """Record exact-refetch evidence and expose only confirmed absences."""
        source_state = self.state.get_source(source)
        evidence = source_state.absence_evidence.get(source_key)
        if evidence is None:
            source_state.tombstone_ready.pop(source_key, None)
        else:
            evidence = {**evidence, "refetch_status": status, "refetched_at": checked_at}
            source_state.absence_evidence[source_key] = evidence
            if status == "absent":
                source_state.tombstone_ready[source_key] = evidence
                source_state.authoritative_snapshot = tuple(
                    key for key in source_state.authoritative_snapshot if key != source_key
                )
                source_state.authoritative_locators.pop(source_key, None)
            else:
                source_state.tombstone_ready.pop(source_key, None)
                if status == "present":
                    source_state.absence_evidence.pop(source_key, None)
        self._dirty = True
        self.save()

    def finish_authoritative_reconciliation(
        self,
        source: str,
        run_id: str,
        *,
        complete: bool,
        completed_at: datetime | None = None,
        minimum_interval: timedelta = timedelta(0),
        grace_period: timedelta = timedelta(0),
    ) -> tuple[str, ...]:
        """Advance absence only after two separated, complete authoritative runs."""
        source_state = self.state.get_source(source)
        if source_state.reconciliation_run_id != run_id:
            raise ValueError(f"Reconciliation run mismatch for {source}")
        if not complete:
            source_state.pending_snapshot = ()
            source_state.pending_locators = {}
            source_state.reconciliation_run_id = None
            source_state.reconciliation_complete = False
            source_state.tombstone_ready = {}
            self._dirty = True
            self.save()
            return ()

        now = completed_at or datetime.now(UTC)
        if now.tzinfo is None:
            now = now.replace(tzinfo=UTC)
        previous = set(source_state.authoritative_snapshot)
        current = set(source_state.pending_snapshot)
        absent = previous - current

        for source_key in current:
            source_state.absence_evidence.pop(source_key, None)
            source_state.tombstone_ready.pop(source_key, None)
        for source_key in tuple(source_state.absence_evidence):
            if source_key not in absent:
                source_state.absence_evidence.pop(source_key, None)
                source_state.tombstone_ready.pop(source_key, None)

        candidates: list[str] = []
        for source_key in sorted(absent):
            prior = source_state.absence_evidence.get(source_key)
            if prior is None:
                source_state.absence_evidence[source_key] = {
                    "first_absent_run_id": run_id,
                    "first_absent_at": _rfc3339_millis(now),
                    "last_absent_run_id": run_id,
                    "last_absent_at": _rfc3339_millis(now),
                    "complete_absence_runs": 1,
                    "locator": source_state.authoritative_locators.get(source_key),
                }
                continue
            first_at = datetime.fromisoformat(str(prior["first_absent_at"]).replace("Z", "+00:00"))
            last_at = datetime.fromisoformat(str(prior["last_absent_at"]).replace("Z", "+00:00"))
            distinct_run = prior.get("last_absent_run_id") != run_id
            separated = now - last_at >= minimum_interval
            grace_elapsed = now - first_at >= grace_period
            runs = int(prior.get("complete_absence_runs", 1))
            if distinct_run and separated:
                runs += 1
            evidence = {
                **prior,
                "locator": prior.get("locator") or source_state.authoritative_locators.get(source_key),
                "last_absent_run_id": run_id,
                "last_absent_at": _rfc3339_millis(now),
                "complete_absence_runs": runs,
            }
            source_state.absence_evidence[source_key] = evidence
            if runs >= 2 and grace_elapsed:
                candidates.append(source_key)

        source_state.authoritative_snapshot = tuple(sorted(current | absent))
        source_state.authoritative_locators = {
            **source_state.authoritative_locators,
            **source_state.pending_locators,
        }
        source_state.pending_snapshot = ()
        source_state.pending_locators = {}
        source_state.reconciliation_run_id = None
        source_state.reconciliation_complete = True
        source_state.absence_generation += 1
        source_state.tombstone_ready = {}
        self._dirty = True
        self.save()
        return tuple(candidates)

    def get_status(self) -> dict[str, Any]:
        """Get current sync status for all sources."""
        return {
            "sources": {
                name: {
                    "last_successful_sync": state.last_successful_sync,
                    "items_processed": state.items_processed,
                    "items_failed": state.items_failed,
                    "last_error": state.last_error,
                    "has_cursor": state.cursor is not None,
                    "reconciliation_complete": state.reconciliation_complete,
                    "absence_generation": state.absence_generation,
                    "reconciliation_manifest": state.reconciliation_manifest,
                    "tombstone_ready": state.tombstone_ready,
                }
                for name, state in self.state.sources.items()
            },
            "updated_at": self.state.updated_at,
        }


# Singleton instance
_sync_state_manager: SyncStateManager | None = None


def get_sync_state_manager() -> SyncStateManager:
    """Get or create the singleton sync state manager."""
    global _sync_state_manager
    if _sync_state_manager is None:
        _sync_state_manager = SyncStateManager()
    return _sync_state_manager
