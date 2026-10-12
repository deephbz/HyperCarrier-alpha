import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createComposer } from "./composer.mjs";

export async function readAliases(ctx, agentDir = getAgentDir()) {
  const paths = [join(agentDir, "settings.json")];
  if (ctx.isProjectTrusted?.()) paths.push(join(ctx.cwd, ".pi", "settings.json"));
  const aliases = {};
  for (const path of paths) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"))?.hc_hud?.model_aliases;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, alias] of Object.entries(value)) {
          if (typeof alias === "string" && alias.trim()) aliases[key] = alias;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") ctx.ui.notify(`HUD settings: ${error.message}`, "warning");
    }
  }
  return aliases;
}
export default function hudExtension(pi) {
  const composer = createComposer(pi);
  pi.on("session_start", async (_event, ctx) => composer.start(ctx, await readAliases(ctx)));
  for (const event of ["session_info_changed", "session_tree", "model_select", "message_end", "turn_end", "session_compact"]) {
    pi.on(event, (_event, ctx) => composer.refresh(ctx));
  }
  pi.on("session_shutdown", () => composer.shutdown());
  pi.registerCommand("hud", {
    description: "HUD: tier auto|full|compact|minimal, or slots",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 2 && parts[0] === "tier" && ["auto", "full", "compact", "minimal"].includes(parts[1])) {
        composer.setTier(parts[1]);
        ctx.ui.notify(`HUD tier: ${parts[1]}`, "info");
      } else if (args.trim() === "slots") {
        ctx.ui.notify(JSON.stringify(composer.store.dump(), null, 2), "info");
      } else ctx.ui.notify("Usage: /hud tier auto|full|compact|minimal | /hud slots", "info");
    },
  });
}
