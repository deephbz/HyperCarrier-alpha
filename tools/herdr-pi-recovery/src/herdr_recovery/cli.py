"""Imperative command shell for Herdr/Pi recovery."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .core import build_manifest, restore_actions, select_agents

STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "herdr-pi-recovery"
LATEST = STATE_DIR / "latest.json"
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


def run(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, capture_output=True, text=True)


def run_json(args: list[str]) -> dict[str, Any]:
    result = run(args)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{args[0]} returned invalid JSON: {error}") from error



def live_snapshot() -> dict[str, Any]:
    return run_json(["herdr", "api", "snapshot"])


def snapshot_agents(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    return list(snapshot["result"]["snapshot"].get("agents", []))


def process_info(pane_id: str) -> dict[str, Any]:
    response = run_json(["herdr", "pane", "process-info", "--pane", pane_id])
    return response["result"]["process_info"]


def version() -> str:
    return run(["herdr", "--version"]).stdout.strip()


def snapshot_directory() -> Path:
    return STATE_DIR / "snapshots"


def ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
    path.chmod(PRIVATE_DIRECTORY_MODE)


def repair_private_storage() -> None:
    """Repair the tool-owned state hierarchy without touching custom-output parents."""
    ensure_private_directory(STATE_DIR)
    snapshots = snapshot_directory()
    ensure_private_directory(snapshots)
    for candidate in snapshots.iterdir():
        if stat.S_ISREG(candidate.lstat().st_mode):
            candidate.chmod(PRIVATE_FILE_MODE)


def atomic_json_write(path: Path, value: dict[str, Any]) -> None:
    """Write a private artifact without taking ownership of its parent directory."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    descriptor = -1
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            PRIVATE_FILE_MODE,
        )
        os.fchmod(descriptor, PRIVATE_FILE_MODE)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = -1
            json.dump(value, stream, indent=2)
            stream.write("\n")
        temporary.replace(path)
        path.chmod(PRIVATE_FILE_MODE)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        if descriptor != -1:
            os.close(descriptor)


def update_latest(path: Path) -> None:
    repair_private_storage()
    temporary = LATEST.with_suffix(".json.tmp")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(path.resolve())
    temporary.replace(LATEST)


def load_manifest(path: str | None) -> tuple[Path, dict[str, Any]]:
    if path is None:
        repair_private_storage()
    source = Path(path).expanduser() if path else LATEST
    if not source.exists():
        raise RuntimeError(f"recovery snapshot not found: {source}; run `herdr-pi-recovery dump`")
    return source.resolve(), json.loads(source.read_text(encoding="utf-8"))


def default_output(captured_at: datetime) -> Path:
    repair_private_storage()
    return snapshot_directory() / f"{captured_at.strftime('%Y%m%dT%H%M%SZ')}.json"


def command_dump(args: argparse.Namespace) -> int:
    now = datetime.now(UTC)
    snapshot = live_snapshot()
    pi_agents = [agent for agent in snapshot_agents(snapshot) if agent.get("agent") == "pi"]
    processes = {agent["pane_id"]: process_info(agent["pane_id"]) for agent in pi_agents}
    manifest = build_manifest(
        snapshot,
        processes,
        captured_at=now.isoformat().replace("+00:00", "Z"),
        herdr_version=version(),
    )
    output = Path(args.output).expanduser() if args.output else default_output(now)
    atomic_json_write(output, manifest)
    update_latest(output)
    validation = manifest["validation"]
    print(
        f"wrote {output} — resolved {validation['resolved_count']}/"
        f"{validation['pi_agent_count']} Pi panes"
    )
    if not validation["complete"]:
        print(f"unresolved panes: {', '.join(validation['unresolved_panes'])}", file=sys.stderr)
        return 2
    return 0


def table_rows(agents: list[dict[str, Any]]) -> list[str]:
    rows = ["PANE     WORKSPACE  STATUS    SESSION ID                            SOURCE"]
    for agent in agents:
        session = agent.get("session") or {}
        rows.append(
            f"{agent['pane_id']:<8} {str(agent.get('workspace_id') or '-'):<10} "
            f"{str(agent.get('agent_status_at_capture') or '-'):<9} "
            f"{str(session.get('id') or '-'):<37} {str(session.get('source') or '-')}"
        )
    return rows


def command_query(args: argparse.Namespace) -> int:
    source, manifest = load_manifest(args.snapshot)
    agents = [dict(agent) for agent in select_agents(manifest, args.pane)]
    if args.json:
        print(json.dumps({"snapshot": str(source), "agents": agents}, indent=2))
    else:
        print(f"snapshot: {source}")
        print(f"captured: {manifest['captured_at']}")
        print("\n".join(table_rows(agents)))
    return 0


def current_panes() -> dict[str, dict[str, Any]]:
    snapshot = live_snapshot()
    return {
        pane["pane_id"]: pane
        for pane in snapshot["result"]["snapshot"].get("panes", [])
    }


def plan(args: argparse.Namespace) -> tuple[Path, list[dict[str, Any]]]:
    source, manifest = load_manifest(args.snapshot)
    actions = restore_actions(manifest, current_panes(), args.pane, force=args.force)
    return source, actions


def print_plan(source: Path, actions: list[dict[str, Any]]) -> None:
    print(f"snapshot: {source}")
    for action in actions:
        print(f"{action['pane_id']}: {action['disposition']} — {action['reason']}")
        if action["command"]:
            print(f"  {action['command']}")


def command_plan(args: argparse.Namespace) -> int:
    source, actions = plan(args)
    if args.json:
        print(json.dumps({"snapshot": str(source), "actions": actions}, indent=2))
    else:
        print_plan(source, actions)
    return 0 if all(action["disposition"] != "blocked" for action in actions) else 2


def command_restore(args: argparse.Namespace) -> int:
    source, actions = plan(args)
    print_plan(source, actions)
    if not args.execute:
        print("dry run only; pass --execute to start ready sessions")
        return 0 if all(action["disposition"] != "blocked" for action in actions) else 2

    failures = 0
    for action in actions:
        if action["disposition"] != "ready":
            continue
        result = run(action["herdr_argv"], check=False)
        if result.returncode:
            failures += 1
            print(f"{action['pane_id']}: restore failed: {result.stderr.strip()}", file=sys.stderr)
        else:
            print(f"{action['pane_id']}: resume command sent")
    return 1 if failures else 0


def command_doctor(_: argparse.Namespace) -> int:
    problems = 0
    for command in ("herdr", "pi"):
        executable = shutil.which(command)
        if not executable:
            problems += 1
            print(f"missing: {command}")
        else:
            print(f"ok: {command} -> {executable}")
    status = run(["herdr", "integration", "status"], check=False)
    pi_line = next((line for line in status.stdout.splitlines() if line.startswith("pi:")), "pi: unknown")
    print(pi_line)
    if "not installed" in pi_line:
        problems += 1
        print("fix: herdr integration install pi")
    print(f"state: {STATE_DIR}")
    return 1 if problems else 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="herdr-pi-recovery",
        description="Dump, inspect, plan, and restore Herdr pane-to-Pi-session correspondence.",
    )
    commands = root.add_subparsers(dest="command", required=True)

    dump = commands.add_parser("dump", help="write a canonical recovery snapshot")
    dump.add_argument("-o", "--output")
    dump.set_defaults(handler=command_dump)

    query = commands.add_parser("query", help="inspect a saved recovery snapshot")
    add_snapshot_selection(query)
    query.add_argument("--json", action="store_true")
    query.set_defaults(handler=command_query)

    plan_parser = commands.add_parser("plan", help="compare a snapshot with live Herdr panes")
    add_snapshot_selection(plan_parser)
    plan_parser.add_argument("--json", action="store_true")
    plan_parser.add_argument("--force", action="store_true", help="allow replacing a detected agent")
    plan_parser.set_defaults(handler=command_plan)

    restore = commands.add_parser("restore", help="safely resume saved Pi sessions in Herdr panes")
    add_snapshot_selection(restore)
    restore.add_argument("--execute", action="store_true", help="send commands; default is dry-run")
    restore.add_argument("--force", action="store_true", help="replace a detected agent")
    restore.set_defaults(handler=command_restore)

    doctor = commands.add_parser("doctor", help="check commands and the official Herdr Pi integration")
    doctor.set_defaults(handler=command_doctor)
    return root


def add_snapshot_selection(command: argparse.ArgumentParser) -> None:
    command.add_argument("snapshot", nargs="?", help="snapshot path; defaults to the latest dump")
    command.add_argument("--pane", action="append", default=[], help="limit to a pane ID; repeatable")


def main() -> None:
    try:
        arguments = parser().parse_args()
        raise SystemExit(arguments.handler(arguments))
    except (OSError, subprocess.CalledProcessError, RuntimeError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
