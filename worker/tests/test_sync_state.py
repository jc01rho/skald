"""Tests for sync state persistence."""

import json
import tempfile
from pathlib import Path

import pytest

from skald_worker.sync_state import SyncState, SyncStateCorruptionError, SyncStateManager


class TestSyncState:
    """Test SyncState dataclass."""

    def test_default_state(self):
        """Default state has empty sources."""
        state = SyncState()
        assert state.version == "1.0"
        assert state.sources == {}

    def test_get_source_creates_new(self):
        """get_source creates new source state if not exists."""
        state = SyncState()
        source = state.get_source("jira")

        assert "jira" in state.sources
        assert source.last_sync_time is None

    def test_get_source_returns_existing(self):
        """get_source returns existing source state."""
        state = SyncState()
        source1 = state.get_source("jira")
        source1.last_sync_time = "2024-01-01T00:00:00Z"

        source2 = state.get_source("jira")
        assert source2.last_sync_time == "2024-01-01T00:00:00Z"

    def test_to_dict_serializes(self):
        """to_dict produces serializable dict."""
        state = SyncState()
        state.get_source("jira").last_sync_time = "2024-01-01T00:00:00Z"

        data = state.to_dict()

        assert data["version"] == "1.0"
        assert "jira" in data["sources"]
        assert data["sources"]["jira"]["last_sync_time"] == "2024-01-01T00:00:00Z"

        # Should be JSON serializable
        json.dumps(data)

    def test_from_dict_deserializes(self):
        """from_dict reconstructs SyncState."""
        data = {
            "version": "1.0",
            "sources": {
                "jira": {
                    "last_sync_time": "2024-01-01T00:00:00Z",
                    "last_successful_sync": "2024-01-01T00:00:00Z",
                    "items_processed": 50,
                    "items_failed": 2,
                    "last_error": None,
                    "cursor": None,
                    "metadata": {},
                }
            },
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
        }

        state = SyncState.from_dict(data)

        assert state.version == "1.0"
        assert state.sources["jira"].items_processed == 50
        assert state.sources["jira"].items_failed == 2


class TestSyncStateManager:
    """Test SyncStateManager file operations."""

    def test_creates_new_state_if_no_file(self):
        """Creates new state if file doesn't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SyncStateManager(Path(tmpdir) / "nonexistent.json")
            state = manager.state

            assert state.version == "1.0"
            assert state.sources == {}

    def test_loads_existing_state(self):
        """Loads state from existing file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = Path(tmpdir) / "state.json"
            state_file.write_text(
                json.dumps(
                    {
                        "version": "1.0",
                        "sources": {
                            "jira": {
                                "last_sync_time": "2024-01-01T00:00:00Z",
                                "last_successful_sync": "2024-01-01T00:00:00Z",
                                "items_processed": 100,
                                "items_failed": 0,
                                "last_error": None,
                                "cursor": None,
                                "metadata": {},
                            }
                        },
                        "created_at": "2024-01-01T00:00:00Z",
                        "updated_at": "2024-01-01T00:00:00Z",
                    }
                )
            )

            manager = SyncStateManager(str(state_file))
            assert manager.state.sources["jira"].items_processed == 100

    def test_saves_state_to_file(self):
        """Saves state to file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = Path(tmpdir) / "state.json"
            manager = SyncStateManager(str(state_file))

            manager.record_sync_success("jira", items_processed=50, items_failed=5)

            # File should exist
            assert state_file.exists()

            # Reload and verify
            data = json.loads(state_file.read_text())
            assert data["sources"]["jira"]["items_processed"] == 50
            assert data["sources"]["jira"]["items_failed"] == 5

            assert state_file.stat().st_mode & 0o777 == 0o660
            assert not list(state_file.parent.glob(".state.json.*.tmp"))

    def test_record_sync_start(self):
        """Records sync start time."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SyncStateManager(Path(tmpdir) / "state.json")

            manager.record_sync_start("jira")

            assert manager.state.sources["jira"].last_sync_time is not None

    def test_record_sync_success(self):
        """Records successful sync with all details."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SyncStateManager(Path(tmpdir) / "state.json")

            manager.record_sync_success(
                "jira",
                items_processed=100,
                items_failed=5,
                cursor="next_page_token",
                metadata={"jql": "project = TEST"},
            )

            source = manager.state.sources["jira"]
            assert source.items_processed == 100
            assert source.items_failed == 5
            assert source.cursor == "next_page_token"
            assert source.metadata["jql"] == "project = TEST"
            assert source.last_error is None

    def test_record_sync_failure(self):
        """Records failed sync with error message."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SyncStateManager(Path(tmpdir) / "state.json")

            manager.record_sync_failure("jira", "Connection timeout")

            source = manager.state.sources["jira"]
            assert source.last_error == "Connection timeout"
            assert source.last_sync_time is not None

    def test_failed_run_preserves_success_watermark_and_cursor_after_restart(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = Path(tmpdir) / "nested" / "state.json"
            manager = SyncStateManager(state_file)
            manager.record_sync_success(
                "spms-functions",
                items_processed=25,
                cursor="page-4",
            )
            successful_at = manager.state.sources["spms-functions"].last_successful_sync

            manager.record_sync_failure("spms-functions", "SPMS page 4 failed")

            restarted = SyncStateManager(state_file)
            source = restarted.state.sources["spms-functions"]
            assert source.last_successful_sync == successful_at
            assert source.cursor == "page-4"
            assert source.last_error == "SPMS page 4 failed"

    def test_get_last_sync_time(self):
        """Returns last successful sync time as datetime."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SyncStateManager(Path(tmpdir) / "state.json")

            # Initially None
            assert manager.get_last_sync_time("jira") is None

            # After success
            manager.record_sync_success("jira", items_processed=10)
            last_sync = manager.get_last_sync_time("jira")
            assert last_sync is not None

    def test_get_cursor(self):
        """Returns pagination cursor for source."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SyncStateManager(Path(tmpdir) / "state.json")

            assert manager.get_cursor("jira") is None

            manager.record_sync_success("jira", items_processed=10, cursor="page_2")
            assert manager.get_cursor("jira") == "page_2"

    def test_clear_cursor(self):
        """Clears pagination cursor for full resync."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SyncStateManager(Path(tmpdir) / "state.json")

            manager.record_sync_success("jira", items_processed=10, cursor="page_2")
            manager.clear_cursor("jira")

            assert manager.get_cursor("jira") is None

    def test_get_status(self):
        """Returns status summary for all sources."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manager = SyncStateManager(Path(tmpdir) / "state.json")

            manager.record_sync_success("jira", items_processed=50, cursor="next")
            manager.record_sync_failure("docs", "API error")

            status = manager.get_status()

            assert "sources" in status
            assert status["sources"]["jira"]["items_processed"] == 50
            assert status["sources"]["jira"]["has_cursor"] is True
            assert status["sources"]["docs"]["last_error"] == "API error"

    def test_corrupt_file_fails_closed_and_preserves_evidence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = Path(tmpdir) / "state.json"
            corrupt_content = "not valid json {{{"
            state_file.write_text(corrupt_content)

            manager = SyncStateManager(str(state_file))

            with pytest.raises(SyncStateCorruptionError, match="Corrupt sync state"):
                _ = manager.state
            assert state_file.read_text() == corrupt_content
            with pytest.raises(SyncStateCorruptionError, match="Corrupt sync state"):
                manager.record_sync_failure("docs", "upstream failed")
            assert state_file.read_text() == corrupt_content

    def test_authoritative_manifest_survives_manager_restart(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = Path(tmpdir) / "state.json"
            manager = SyncStateManager(state_file)
            manager.begin_authoritative_reconciliation("spms-functions", "run-1")
            manager.record_authoritative_presence(
                "spms-functions",
                "spms:function:17",
                locator="SVR-17",
            )
            manager.update_reconciliation_manifest(
                "spms-functions",
                {
                    "run_id": "run-1",
                    "pages": [1],
                    "ids": ["17"],
                    "terminal_page": None,
                    "complete": False,
                    "errors": [],
                },
            )

            restarted = SyncStateManager(state_file)
            source = restarted.state.sources["spms-functions"]
            assert source.reconciliation_run_id == "run-1"
            assert source.pending_snapshot == ("spms:function:17",)
            assert source.pending_locators == {"spms:function:17": "SVR-17"}
            assert source.reconciliation_manifest["pages"] == [1]
            assert source.reconciliation_manifest["complete"] is False
