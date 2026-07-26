#!/usr/bin/env node
import { notifyRarebit } from "./rarebit.mjs";

const paneId = process.argv[2] || null;
setTimeout(async () => {
  try {
    await notifyRarebit(paneId);
  } catch (error) {
    process.stderr.write(
      `Cannot show Rarebit notification: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}, 180);
