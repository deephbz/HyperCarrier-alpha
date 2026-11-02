// Team value types for the wire contract.
// Pi Team views produce these values; hub and web Team consumers read them.
import type { TeamMessages } from "./team-messages.ts";

export type PiTeamTask = { id: string; title: string; status: string; owner?: string; deps: string[]; ready: boolean; updatedAt?: string };

export type TeamValue = {
	availability: string;
	teams: { name: string; members: { member: string; role: string; threadId?: string; ref?: string; pane?: string; live: boolean; status: string }[]; tasks: PiTeamTask[]; messages: TeamMessages; issues: string[] }[];
};
