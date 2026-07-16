import { readFile } from "node:fs/promises";
import type { Evidence } from "../../domain/contracts.js";
export interface TeamAttributionEvidence {
  session_file: string;
  member_name: string | null;
  team_name: string;
  is_leader: boolean;
  evidence: Evidence;
}
/** Reads only explicit sessionFile and lead-session mappings; cwd/time/filename are never attribution. */
export async function readAllowlistedAttribution(
  teamDirectory: string,
): Promise<TeamAttributionEvidence[]> {
  try {
    const config = JSON.parse(
      await readFile(`${teamDirectory}/config.json`, "utf8"),
    );
    const team_name = String(config.name ?? config.teamName ?? "unknown");
    const rows: TeamAttributionEvidence[] = [];
    for (const member of config.members ?? []) {
      if (typeof member.sessionFile === "string")
        rows.push({
          session_file: member.sessionFile,
          member_name: typeof member.name === "string" ? member.name : null,
          team_name,
          is_leader: false,
          evidence: {
            class: "observed",
            basis: "PiTeams config explicit member.sessionFile",
          },
        });
    }
    try {
      const lead = JSON.parse(
        await readFile(`${teamDirectory}/lead-session.json`, "utf8"),
      );
      if (typeof lead.sessionFile === "string")
        rows.push({
          session_file: lead.sessionFile,
          member_name: "team-lead",
          team_name,
          is_leader: true,
          evidence: {
            class: "observed",
            basis: "PiTeams lead-session explicit sessionFile",
          },
        });
    } catch {}
    return rows;
  } catch {
    return [];
  }
}
export const unavailableAttribution = (team_name: string): Evidence => ({
  class: "unavailable",
  basis: "PiTeams attribution adapter",
  unavailable_reason: `no explicit sessionFile mapping for ${team_name}`,
});
