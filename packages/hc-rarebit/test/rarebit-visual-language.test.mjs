import test from "node:test";
import assert from "node:assert/strict";
import {
  rarebitEventPresentation,
  rarebitOccurrencePresentation,
  rarebitSummaryPresentation,
} from "../src/rarebit-visual-language.mjs";

test("event presentation preserves the canonical occurrence grammar", () => {
  assert.deepEqual(rarebitEventPresentation("user_message"), {
    mark: "□",
    label: "user message",
    tone: "user",
    salience: "standard",
  });
  assert.deepEqual(
    rarebitOccurrencePresentation({
      role: "assistant",
      outcome: "continuation",
    }),
    {
      mark: "•",
      label: "agent continues",
      tone: "continuation",
      salience: "smaller",
    },
  );
  assert.deepEqual(
    rarebitOccurrencePresentation({ role: "assistant", outcome: "stop" }),
    {
      mark: "●",
      label: "agent stops",
      tone: "boundary",
      salience: "larger",
    },
  );
  assert.equal(rarebitEventPresentation("terminal_error").mark, "×");
});

test("Summary presentation keeps ordinary outcomes neutral and attention singular", () => {
  assert.deepEqual(rarebitSummaryPresentation("finished"), {
    mark: null,
    label: "appears finished",
    tone: "neutral",
    salience: "ordinary",
  });
  assert.deepEqual(rarebitSummaryPresentation("needs_attention"), {
    mark: "◆!",
    label: "needs you",
    tone: "attention",
    salience: "attention",
  });
  assert.deepEqual(
    rarebitSummaryPresentation("needs_attention", { sourcePending: true }),
    {
      mark: null,
      label: "needs you · source pending",
      tone: "neutral",
      salience: "ordinary",
    },
  );
  assert.equal(rarebitSummaryPresentation("error").mark, "×");
  assert.equal(rarebitSummaryPresentation("ineligible").tone, "muted");
});

test("unknown semantic roles fail instead of inventing a visual category", () => {
  assert.throws(
    () => rarebitOccurrencePresentation({ role: "tool", outcome: "stop" }),
    /Unknown Rarebit occurrence role\/outcome/,
  );
  assert.throws(
    () => rarebitSummaryPresentation("successful"),
    /Unknown Rarebit Summary status/,
  );
});
