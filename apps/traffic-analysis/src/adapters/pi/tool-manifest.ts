export const TOOL_OWNER_MANIFEST_VERSION = "tool-owner-manifest-v2";
/** Version-pinned local ownership manifest. Unknown/conflicting persisted names remain explicit unknown. */
const core = ["read", "bash", "edit", "write"];
const piTeams = [
  "team_create",
  "spawn_teammate",
  "spawn_lead_window",
  "send_message",
  "broadcast_message",
  "read_inbox",
  "task_create",
  "task_submit_plan",
  "task_evaluate_plan",
  "task_list",
  "task_update",
  "task_read",
  "team_shutdown",
  "check_teammate",
  "process_shutdown_approved",
  "cleanup_agent_sessions",
  "list_predefined_teams",
  "list_predefined_agents",
  "create_predefined_team",
  "save_team_as_template",
  "list_runtime_teams",
];
const piContext = ["context_checkpoint", "context_timeline", "context_compact"];
const piWeb = ["web_search", "fetch_content", "get_search_content"];
const piIntercom = ["intercom"];
export const TOOL_OWNER_MANIFEST: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries([
      ...core.map((x) => [x, "pi-core"]),
      ...piTeams.map((x) => [x, "extension:pi-teams"]),
      ...piContext.map((x) => [x, "extension:pi-context"]),
      ...piWeb.map((x) => [x, "extension:pi-web-access"]),
      ...piIntercom.map((x) => [x, "extension:pi-intercom"]),
    ]),
  );
export function toolOwner(name: string | null): string {
  return name ? (TOOL_OWNER_MANIFEST[name] ?? "unknown") : "unknown";
}
