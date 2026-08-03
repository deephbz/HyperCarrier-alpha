import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const SYSTEM_PROMPT_EXPORT_SCHEMA_VERSION = 1;
export const DEFAULT_SYSTEM_PROMPT_EXPORT_DIRECTORY = ".pi/prompt-snapshots";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Return JSON-only data so the on-disk evidence stays portable and stable. */
function jsonValue(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized);
}

function cloneTool(tool) {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: jsonValue(tool.parameters),
    ...(tool.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...tool.promptGuidelines] }),
    sourceInfo: jsonValue(tool.sourceInfo),
  };
}

export function createSystemPromptExport(input, now = new Date()) {
  const toolsByName = new Map(input.allTools.map((tool) => [tool.name, tool]));
  const activeTools = input.activeToolNames.map((name) => {
    const tool = toolsByName.get(name);
    if (!tool) {
      throw new Error(`Active tool '${name}' was not returned by pi.getAllTools().`);
    }
    return cloneTool(tool);
  });

  const content = JSON.stringify({ systemPrompt: input.systemPrompt, activeTools });
  return {
    schemaVersion: SYSTEM_PROMPT_EXPORT_SCHEMA_VERSION,
    capturedAt: now.toISOString(),
    cwd: path.resolve(input.cwd),
    systemPrompt: input.systemPrompt,
    activeTools,
    provenance: {
      systemPrompt: "ctx.getSystemPrompt",
      toolDefinitions: "pi.getAllTools filtered by pi.getActiveTools",
      limitation:
        "This captures Pi's effective prompt and active tool definitions, not later provider-payload rewrites.",
    },
    integrity: { contentSha256: sha256(content) },
  };
}

function resolveOutputPath(cwd, requestedPath, now, randomSuffix) {
  const root = path.resolve(cwd);
  const defaultName = `system-prompt-${now.toISOString().replace(/[:.]/g, "-")}-${randomSuffix}.json`;
  const output = path.resolve(
    root,
    requestedPath || path.join(DEFAULT_SYSTEM_PROMPT_EXPORT_DIRECTORY, defaultName),
  );
  const relative = path.relative(root, output);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("output_path must resolve inside the current working directory.");
  }
  if (path.extname(output).toLowerCase() !== ".json") {
    throw new Error("output_path must end in .json.");
  }
  return output;
}

/**
 * Persist an immutable, machine-readable snapshot. `wx` intentionally refuses
 * replacement so an export remains an evidence record rather than a cache.
 */
export async function writeSystemPromptExport(input, options = {}) {
  const now = options.now ?? new Date();
  const randomSuffix = options.randomSuffix ?? randomBytes(6).toString("hex");
  const artifact = createSystemPromptExport(input, now);
  const outputPath = resolveOutputPath(
    input.cwd,
    options.outputPath,
    now,
    randomSuffix,
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { artifact, outputPath };
}

/** Register an operator-only Pi command; it is absent from the model tool surface. */
export function registerSystemPromptExportCommand(pi) {
  pi.registerCommand("export-system-prompt", {
    description: "Export the effective system prompt and active tool definitions to immutable JSON",
    handler: async (args, ctx) => {
      const requestedPath = args.trim() || undefined;
      const { artifact, outputPath } = await writeSystemPromptExport(
        {
          cwd: ctx.cwd,
          systemPrompt: ctx.getSystemPrompt(),
          activeToolNames: pi.getActiveTools(),
          allTools: pi.getAllTools(),
        },
        { outputPath: requestedPath },
      );
      const message = `Exported the effective system prompt and ${artifact.activeTools.length} active tool definitions to ${outputPath}. SHA-256: ${artifact.integrity.contentSha256}`;
      ctx.ui?.notify?.(message, "info");
      return {
        outputPath,
        schemaVersion: artifact.schemaVersion,
        capturedAt: artifact.capturedAt,
        activeToolCount: artifact.activeTools.length,
        contentSha256: artifact.integrity.contentSha256,
      };
    },
  });
}
