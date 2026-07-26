from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from herdr_recovery import cli
from herdr_recovery.core import build_manifest, restore_actions


class RecoveryCoreTest(unittest.TestCase):
    def test_build_manifest_keeps_missing_native_session_unresolved(self) -> None:
        snapshot = {
            "result": {
                "snapshot": {
                    "agents": [
                        {
                            "agent": "pi",
                            "agent_status": "idle",
                            "cwd": "/repo",
                            "pane_id": "w1:p1",
                            "terminal_id": "term-1",
                            "workspace_id": "w1",
                            "tab_id": "w1:t1",
                        }
                    ]
                }
            }
        }
        process_info = {
            "w1:p1": {
                "foreground_processes": [
                    {"argv0": "pi", "name": "node", "pid": 42}
                ]
            }
        }
        manifest = build_manifest(
            snapshot,
            process_info,
            captured_at="2026-07-25T00:00:00Z",
            herdr_version="herdr 0.7.3",
        )

        agent = manifest["agents"][0]
        self.assertIsNone(agent["session"])
        self.assertIsNone(agent["resume"])
        self.assertFalse(manifest["validation"]["complete"])

    def test_native_herdr_session_is_the_only_recovery_source(self) -> None:
        snapshot = {
            "result": {
                "snapshot": {
                    "agents": [
                        {
                            "agent": "pi",
                            "agent_status": "idle",
                            "cwd": "/repo with space",
                            "pane_id": "w1:p1",
                            "agent_session": {
                                "kind": "id",
                                "value": "native-id",
                                "source": "pi-extension",
                            },
                        }
                    ]
                }
            }
        }
        manifest = build_manifest(
            snapshot,
            {},
            captured_at="now",
            herdr_version="test",
        )
        agent = manifest["agents"][0]
        self.assertEqual(agent["session"]["source"], "herdr_api")
        self.assertEqual(
            agent["resume"]["command"],
            "cd '/repo with space' && exec pi --session native-id",
        )

    def test_restore_is_guarded_when_agent_already_exists(self) -> None:
        manifest = {
            "agents": [
                {
                    "pane_id": "w1:p1",
                    "session": {"id": "s"},
                    "resume": {
                        "command": "exec pi --session s",
                        "herdr_argv": ["herdr", "pane", "run", "w1:p1", "exec pi --session s"],
                    },
                }
            ]
        }
        live = {"w1:p1": {"agent": "pi"}}
        self.assertEqual(restore_actions(manifest, live)[0]["disposition"], "skipped")
        self.assertEqual(
            restore_actions(manifest, live, force=True)[0]["disposition"], "ready"
        )


class RecoveryStoragePrivacyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.previous_state_dir = cli.STATE_DIR
        self.previous_latest = cli.LATEST
        cli.STATE_DIR = self.root / "state" / "herdr-pi-recovery"
        cli.LATEST = cli.STATE_DIR / "latest.json"

    def tearDown(self) -> None:
        cli.STATE_DIR = self.previous_state_dir
        cli.LATEST = self.previous_latest
        self.temporary_directory.cleanup()

    def mode(self, path: Path) -> int:
        return stat.S_IMODE(path.stat().st_mode)

    def with_permissive_umask(self, callback):
        previous_umask = os.umask(0)
        try:
            return callback()
        finally:
            os.umask(previous_umask)

    def test_default_storage_repairs_permissions_and_keeps_latest_atomic(self) -> None:
        snapshots = cli.snapshot_directory()
        snapshots.mkdir(parents=True)
        cli.STATE_DIR.chmod(0o755)
        snapshots.chmod(0o755)
        old_snapshot = snapshots / "old.json"
        old_snapshot.write_text("{}\n", encoding="utf-8")
        old_snapshot.chmod(0o644)
        outside_target = self.root / "outside.json"
        outside_target.write_text("not a snapshot\n", encoding="utf-8")
        outside_target.chmod(0o644)
        hostile_link = snapshots / "hostile-link"
        hostile_link.symlink_to(outside_target)
        opened_modes: list[int] = []
        original_open = os.open

        def record_open(path, flags, mode=0o777):
            opened_modes.append(mode)
            return original_open(path, flags, mode)

        output = cli.default_output(datetime(2026, 7, 26, tzinfo=UTC))
        with patch("herdr_recovery.cli.os.open", side_effect=record_open):
            self.with_permissive_umask(
                lambda: cli.atomic_json_write(output, {"revision": 1}),
            )
        cli.update_latest(output)
        self.assertEqual(self.mode(cli.STATE_DIR), 0o700)
        self.assertEqual(self.mode(snapshots), 0o700)
        self.assertEqual(self.mode(old_snapshot), 0o600)
        self.assertEqual(self.mode(output), 0o600)
        self.assertEqual(opened_modes, [0o600])
        self.assertTrue(hostile_link.is_symlink())
        self.assertEqual(self.mode(outside_target), 0o644)
        self.assertTrue(cli.LATEST.is_symlink())
        self.assertEqual(cli.LATEST.resolve(), output.resolve())
        self.assertEqual(json.loads(cli.LATEST.read_text(encoding="utf-8")), {"revision": 1})

        cli.atomic_json_write(output, {"revision": 2})
        cli.update_latest(output)
        self.assertEqual(json.loads(cli.LATEST.read_text(encoding="utf-8")), {"revision": 2})
        self.assertEqual(self.mode(output), 0o600)

    def test_custom_output_keeps_existing_parent_mode_and_cleans_failed_temp(self) -> None:
        custom_parent = self.root / "outside"
        custom_parent.mkdir()
        custom_parent.chmod(0o755)
        output = custom_parent / "snapshot.json"
        self.with_permissive_umask(
            lambda: cli.atomic_json_write(output, {"custom": True}),
        )
        self.assertEqual(self.mode(custom_parent), 0o755)
        self.assertEqual(self.mode(output), 0o600)

        previous = self.root / "previous.json"
        cli.atomic_json_write(previous, {"previous": True})
        cli.update_latest(previous)
        failed = custom_parent / "failed.json"
        with patch("herdr_recovery.cli.json.dump", side_effect=OSError("write failed")):
            with self.assertRaisesRegex(OSError, "write failed"):
                cli.atomic_json_write(failed, {"custom": False})
        self.assertFalse(failed.exists())
        self.assertFalse(failed.with_suffix(".json.tmp").exists())
        self.assertEqual(cli.LATEST.resolve(), previous.resolve())

        missing_output = self.root / "caller-owned-missing" / "snapshot.json"
        with self.assertRaises(FileNotFoundError):
            cli.atomic_json_write(missing_output, {"custom": "missing parent"})
        self.assertFalse(missing_output.parent.exists())
        self.assertEqual(cli.LATEST.resolve(), previous.resolve())


if __name__ == "__main__":
    unittest.main()
