#!/usr/bin/env node
import {
  createPiSynthesisClient,
  loadRegistry,
  distillProject,
} from "../src/index.mjs";

function args(argv) {
  const result = { trace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--trace") result.trace = true;
    else if (item === "--synthesis-pi") result.synthesis_pi = true;
    else if (item.startsWith("--"))
      result[item.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  return result;
}

const options = args(process.argv.slice(2));
if (!options.registry || !options.project) {
  console.error(
    "Usage: hc-project-distill --registry <path> --project <stable-project-id> [--base-hash <sha256>] [--trace] [--synthesis-pi --synthesis-model <provider/model> --synthesis-timeout-ms <ms>]",
  );
  process.exitCode = 2;
} else {
  try {
    const registry = await loadRegistry(options.registry);
    const project = registry.projects.find(
      (candidate) => candidate.id === options.project,
    );
    if (!project)
      throw new Error(`Unknown explicit Project id: ${options.project}`);
    const synthesisModel = options.synthesis_model
      ? (() => {
          const slash = options.synthesis_model.indexOf("/");
          if (slash < 1)
            throw new Error("--synthesis-model must be provider/model");
          return {
            provider: options.synthesis_model.slice(0, slash),
            id: options.synthesis_model.slice(slash + 1),
          };
        })()
      : undefined;
    const result = await distillProject({
      project,
      registryVersion: registry.registryVersion,
      baseHash: options.base_hash,
      trace: options.trace,
      eventsPath: options.events,
      proposalDir: options.output_dir,
      synthesisModel,
      synthesisClient: options.synthesis_pi
        ? createPiSynthesisClient({
            cwd: process.cwd(),
            timeoutMs: Number(options.synthesis_timeout_ms ?? 120000),
          })
        : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
