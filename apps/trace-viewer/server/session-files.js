import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function safeReadDir(path, options) {
  try {
    return readdirSync(path, options);
  } catch {
    return [];
  }
}

export function findSessionFiles(root = join(homedir(), ".pi", "agent", "sessions")) {
  const files = [];
  for (const entry of safeReadDir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...findSessionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files.sort();
}
