// Count glyphs for Arc chunk rows. They reuse the Rarebit vocabulary (□ for an owner turn, as in the Rarebit stats)
// and the Shell button's ›_ for a tool call. Change a glyph here; callers keep their counts and tooltips.

export const GLYPHS = {
	ownerTurns: { glyph: "□", one: "owner turn", many: "owner turns" },
	toolCalls: { glyph: "›_", one: "tool call", many: "tool calls" },
} as const;

export const glyphTitle = (kind: keyof typeof GLYPHS, n: number) => `${n} ${n === 1 ? GLYPHS[kind].one : GLYPHS[kind].many}`;
