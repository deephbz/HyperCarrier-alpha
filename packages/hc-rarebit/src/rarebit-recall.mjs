import { constants } from "node:fs";
import { access, chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { selectRarebits } from "./rarebit-core.mjs";

export const RAREBIT_RECALL_SCHEMA_VERSION = 1;
export const RAREBIT_CONVERSATION_SCHEMA_VERSION = 1;
export const RAREBIT_RECALL_DETAILED_FILENAME = "rarebit-evidence.json";
export const RAREBIT_RECALL_CONVERSATION_FILENAME = "rarebit-conversation.json";

function requiredSessionIdentity(ctx) {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (typeof sessionFile !== "string" || !sessionFile.trim()) {
    throw new Error("the current Pi Session has no persisted JSONL file");
  }
  const sessionId = ctx?.sessionManager?.getHeader?.()?.id ?? ctx?.sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("the current Pi Session has no stable ID");
  }
  return { sessionId, sessionFile: resolve(sessionFile) };
}

function activeBranchFrom(ctx) {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) {
    throw new Error("the current Pi Session active branch is unavailable");
  }
  return branch;
}

function recallDocument({ sessionId, sessionFile, branch, selection, now }) {
  return {
    schemaVersion: RAREBIT_RECALL_SCHEMA_VERSION,
    type: "rarebit_message_recall",
    createdAt: now().toISOString(),
    evidenceAuthority: {
      type: "pi_session_jsonl",
      path: sessionFile,
    },
    session: {
      id: sessionId,
      activeBranch: {
        leafEntryId: branch.at(-1)?.id ?? null,
        entryIds: branch.map((entry) => entry?.id ?? null),
      },
    },
    selection: {
      selectorVersion: selection.manifest.selectorVersion,
      manifestHash: selection.manifestHash,
      occurrenceCount: selection.occurrences.length,
      uniquePayloadCount: selection.payloads.length,
      occurrences: selection.occurrences.map(
        ({
          occurrenceId,
          sourceEntryId,
          order,
          timestamp,
          role,
          outcome,
          producer,
          contentHash,
          text,
        }) => ({
          occurrenceId,
          sourceEntryId,
          order,
          timestamp,
          role,
          outcome,
          producer,
          contentHash,
          text,
        }),
      ),
    },
  };
}

function conversationHour(timestamp) {
  if (typeof timestamp !== "string") return null;
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return null;
  return `${value.toISOString().slice(0, 13)}:00Z`;
}

function conversationDocument(selection) {
  const byHour = new Map();
  for (const occurrence of selection.occurrences) {
    const hour = conversationHour(occurrence.timestamp);
    let bucket = byHour.get(hour);
    if (!bucket) {
      bucket = { hour, messages: [] };
      byHour.set(hour, bucket);
    }
    bucket.messages.push({
      role: occurrence.role === "user" ? "user" : "agent",
      content: occurrence.text,
    });
  }
  const hours = [...byHour.values()].sort((left, right) => {
    if (left.hour === null) return right.hour === null ? 0 : 1;
    if (right.hour === null) return -1;
    return left.hour.localeCompare(right.hour);
  });
  return {
    schemaVersion: RAREBIT_CONVERSATION_SCHEMA_VERSION,
    type: "rarebit_conversation",
    timeZone: "UTC",
    hours,
  };
}

async function writePrivateJson(path, document) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

/**
 * Materialize an exact, active-branch Rarebit evidence projection for one
 * human-triggered recall. The native Session remains authority; this bundle is
 * an ephemeral, private transport artifact and is never written to the repo.
 */
export async function materializeRarebitRecall(
  ctx,
  {
    tempRoot = tmpdir(),
    now = () => new Date(),
    writeJson = writePrivateJson,
  } = {},
) {
  const { sessionId, sessionFile } = requiredSessionIdentity(ctx);
  await access(sessionFile, constants.R_OK);
  const branch = activeBranchFrom(ctx);
  const selection = selectRarebits(branch);
  const root = resolve(tempRoot);
  const directory = await mkdtemp(join(root, "hc-rarebit-recall-"));
  const conversationPath = join(
    directory,
    RAREBIT_RECALL_CONVERSATION_FILENAME,
  );
  const detailedPath = join(directory, RAREBIT_RECALL_DETAILED_FILENAME);

  try {
    await chmod(directory, 0o700);
    const detailed = recallDocument({
      sessionId,
      sessionFile,
      branch,
      selection,
      now,
    });
    const conversation = conversationDocument(selection);
    await writeJson(conversationPath, conversation);
    await writeJson(detailedPath, detailed);
    if (!isAbsolute(conversationPath) || !isAbsolute(detailedPath)) {
      throw new Error(
        "Rarebit recall materialization did not produce absolute paths",
      );
    }
    return {
      conversationPath,
      detailedPath,
      directory,
      sessionId,
      sessionFile,
      branchLeafId: detailed.session.activeBranch.leafEntryId,
      selectedMessageCount: selection.occurrences.length,
      selectorVersion: selection.manifest.selectorVersion,
      manifestHash: selection.manifestHash,
      discard: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
