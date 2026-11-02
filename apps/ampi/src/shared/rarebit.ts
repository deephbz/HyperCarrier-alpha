// Rarebit side conversation types for the wire contract.
// Pi Rarebit views produce these values; web Rarebit consumers read them.
export type RarebitFailure = { error: { code: string; message: string } };

export type SideTurn = { question: string; answer?: string; error?: string };

export type RarebitSide = { id: string; at: string; count: number; included: number; omittedChars: number; revision: number; turns: SideTurn[]; model: string };
