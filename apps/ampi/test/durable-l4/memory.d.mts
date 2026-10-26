export type Process = { pid: number; ppid: number; command: string };
export type Roots = { hub: number; node: number; tools?: number[] };
export type Role = "hub" | "agent" | "node" | "helpers" | "tools";
export type TreeSample = {
	atMs: number;
	roots: Roots & { agents: number[]; tools: number[] };
	totals: Record<Role, number>;
	rows: { pid: number; role: Role; bytes: number; errno: number }[];
};
export function classifyProcesses(processes: Process[], roots: Roots): { agents: number[]; roles: Map<number, Role> };
export function sampleTrees(binary: string, roots: Roots): TreeSample;
export function slopeBytesPerHour(samples: TreeSample[], role: Role): number;
