"""Pure transformations for Herdr/Pi recovery artifacts."""

from __future__ import annotations

import shlex
from collections.abc import Iterable, Mapping
from typing import Any

Json = dict[str, Any]


def agent_session_from_sources(
    agent: Mapping[str, Any],
    process_info: Mapping[str, Any] | None,
) -> Json | None:
    """Resolve session identity, preferring Herdr's native integration report."""
    native = agent.get("agent_session")
    if isinstance(native, Mapping) and native.get("value"):
        value = str(native["value"])
        kind = str(native.get("kind", "id"))
        return {
            "id": value if kind == "id" else None,
            "path": value if kind == "path" else None,
            "reference": value,
            "reference_kind": kind,
            "source": "herdr_api",
            "reported_by": native.get("source"),
        }

    return None


def resume_command(cwd: str, session_reference: str) -> str:
    """Build the shell command Herdr will run in a restored pane."""
    return f"cd {shlex.quote(cwd)} && exec pi --session {shlex.quote(session_reference)}"


def build_manifest(
    snapshot_response: Mapping[str, Any],
    process_info_by_pane: Mapping[str, Mapping[str, Any]],
    *,
    captured_at: str,
    herdr_version: str,
) -> Json:
    """Join Herdr topology and its native Pi-session evidence."""
    snapshot = snapshot_response.get("result", {}).get("snapshot", snapshot_response)
    agents = snapshot.get("agents", [])
    records: list[Json] = []

    for agent in sorted(agents, key=lambda item: str(item.get("pane_id", ""))):
        if agent.get("agent") != "pi":
            continue
        pane_id = str(agent["pane_id"])
        process_info = process_info_by_pane.get(pane_id)
        session = agent_session_from_sources(agent, process_info)
        cwd = str(agent.get("foreground_cwd") or agent.get("cwd") or "~")
        record: Json = {
            "pane_id": pane_id,
            "terminal_id": agent.get("terminal_id"),
            "workspace_id": agent.get("workspace_id"),
            "tab_id": agent.get("tab_id"),
            "cwd": cwd,
            "agent_status_at_capture": agent.get("agent_status"),
            "process_info": process_info,
            "session": session,
            "resume": None,
        }
        if session:
            command = resume_command(cwd, session["reference"])
            record["resume"] = {
                "command": command,
                "herdr_argv": ["herdr", "pane", "run", pane_id, command],
            }
        records.append(record)

    unresolved = [record["pane_id"] for record in records if record["session"] is None]
    return {
        "schema_version": 1,
        "captured_at": captured_at,
        "herdr_version": herdr_version,
        "agents": records,
        "validation": {
            "complete": not unresolved,
            "pi_agent_count": len(records),
            "resolved_count": len(records) - len(unresolved),
            "unresolved_panes": unresolved,
        },
        "raw": {"herdr_snapshot": snapshot_response},
    }


def select_agents(manifest: Mapping[str, Any], panes: Iterable[str] = ()) -> list[Mapping[str, Any]]:
    """Select all recoverable agents or an explicit pane subset."""
    wanted = set(panes)
    agents = list(manifest.get("agents", []))
    return [agent for agent in agents if not wanted or agent.get("pane_id") in wanted]


def restore_actions(
    manifest: Mapping[str, Any],
    live_panes: Mapping[str, Mapping[str, Any]],
    panes: Iterable[str] = (),
    *,
    force: bool = False,
) -> list[Json]:
    """Plan safe restore actions without performing side effects."""
    actions: list[Json] = []
    for agent in select_agents(manifest, panes):
        pane_id = str(agent["pane_id"])
        live = live_panes.get(pane_id)
        if live is None:
            disposition, reason = "blocked", "pane is absent from the live Herdr session"
        elif agent.get("session") is None:
            disposition, reason = "blocked", "snapshot has no Pi session reference"
        elif live.get("agent") and not force:
            disposition, reason = "skipped", "pane already contains a detected agent"
        else:
            disposition, reason = "ready", "pane exists and has no detected agent"
        actions.append(
            {
                "pane_id": pane_id,
                "disposition": disposition,
                "reason": reason,
                "command": (agent.get("resume") or {}).get("command"),
                "herdr_argv": (agent.get("resume") or {}).get("herdr_argv"),
            }
        )
    return actions
