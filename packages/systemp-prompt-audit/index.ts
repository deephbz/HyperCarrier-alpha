import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSystemPromptExportCommand } from "./system-prompt-export.mjs";

export default function systemPromptExportExtension(pi: ExtensionAPI) {
  registerSystemPromptExportCommand(pi);
}
