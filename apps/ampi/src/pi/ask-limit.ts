// Isolated ask process only: cap the serialized output budget before the provider receives it.
export function limitOutput(payload: unknown, limit: number): unknown {
 if (!payload || typeof payload !== "object") throw new Error("Unknown provider payload for output limit");
 const p = payload as Record<string, any>;
 for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
  if (key in p) return { ...p, [key]: Math.min(typeof p[key] === "number" ? p[key] : limit, limit) };
 }
 if (p.generationConfig) return { ...p, generationConfig: { ...p.generationConfig, maxOutputTokens: Math.min(p.generationConfig.maxOutputTokens ?? limit, limit) } };
 if (p.config) return { ...p, config: { ...p.config, maxOutputTokens: Math.min(p.config.maxOutputTokens ?? limit, limit) } };
 throw new Error("Provider does not expose an output limit");
}
export default function outputLimit(pi: { on(name: string, handler: (event: { payload: unknown }) => unknown): unknown }) {
 const limit = Number(process.env.AMPI_ASK_OUTPUT_TOKENS);
 pi.on("before_provider_request", event => {
  try { return limitOutput(event.payload, limit); }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); }
 });
}
