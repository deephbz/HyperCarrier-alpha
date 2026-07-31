import assert from "node:assert/strict";
import test from "node:test";
import { validateSchema, validateSchemaDefinition } from "../lib/closed-json-schema.mjs";

const draft = "http://json-schema.org/draft-07/schema#";
const schema = { $schema: draft, type: "object", additionalProperties: false, required: ["tag", "items"], properties: { tag: { const: "ok" }, items: { type: "array", minItems: 1, items: { type: "string", pattern: "^[a-z]+$" } }, nested: { type: "object", properties: { state: { enum: ["ready", "done"] }, nil: { type: "null" } } } } };
test("bootstrap schema validator accepts supported nested schema", () => assert.deepEqual(validateSchema({ tag: "ok", items: ["asset"], nested: { state: "ready", nil: null } }, schema), { tag: "ok", items: ["asset"], nested: { state: "ready", nil: null } }));
test("bootstrap schema validator rejects additional/type/const/pattern/array failures", () => {
  assert.throws(() => validateSchema({ tag: "ok", items: ["asset"], extra: true }, schema), /additional property/);
  assert.throws(() => validateSchema({ tag: "no", items: ["asset"] }, schema), /expected constant/);
  assert.throws(() => validateSchema({ tag: "ok", items: ["UPPER"] }, schema), /does not match/);
  assert.throws(() => validateSchema({ tag: "ok", items: [] }, schema), /at least 1/);
});
test("bootstrap schema validator implements finite integer semantics", () => {
  const integer = { $schema: draft, type: "integer" };
  assert.equal(validateSchema(1, integer), 1);
  for (const value of [1.5, NaN, Infinity, "1", null]) assert.throws(() => validateSchema(value, integer), /expected integer/);
});
test("bootstrap schema validator rejects unsupported keywords", () => assert.throws(() => validateSchema("x", { $schema: draft, type: "string", oneOf: [] }), /unsupported schema keyword oneOf/));
test("bootstrap schema definition rejects malformed supported keyword values", () => {
  const malformed = [
    { $schema: "wrong" }, { $schema: draft, $id: 1 }, { $schema: draft, title: 1 }, { $schema: draft, type: "date" },
    { $schema: draft, properties: [] }, { $schema: draft, additionalProperties: "false" }, { $schema: draft, required: ["x", "x"] },
    { $schema: draft, enum: [] }, { $schema: draft, pattern: "[" }, { $schema: draft, minItems: -1 }, { $schema: draft, items: [] },
  ];
  for (const candidate of malformed) assert.throws(() => validateSchemaDefinition(candidate), (error) => error.code === "invalid-schema");
});
