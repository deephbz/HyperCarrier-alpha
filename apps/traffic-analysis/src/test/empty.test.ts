import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySourceStore } from "../application/store.js";
test("empty source selection returns a typed unavailable analysis", () => {
  const result = new InMemorySourceStore().snapshot();
  assert.equal(result.report.title, "Agent-turns viz");
  assert.equal(result.rows.length, 0);
  assert.equal(result.diagnostics[0].code, "source_selection_unavailable");
  assert.equal(result.reconciliation.requests, 0);
});
