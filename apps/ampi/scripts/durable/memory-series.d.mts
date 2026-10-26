export type Sample = { hub: number; agent: number; node: number; helpers: number };
export type Row = { at: number } & (Sample | { hubTree: number; node: number });

export const LIMITS: { hub: number; total: number };
export function sampleLive(hubPort: string, nodePidFile: string): Sample;
export function record(options: { out: string; everyMs: number; count: number; sample: () => Sample; now?: () => Date }): Promise<void>;
export function parseSeries(text: string): Row[];
export function report(rows: Row[], trialEnd: number): { lines: string[]; stop: string[] };
