const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const SCHEMA_KEYWORDS = new Set(["$schema", "$id", "title", "type", "required", "properties", "additionalProperties", "const", "enum", "pattern", "minItems", "items"]);
const SCHEMA_TYPES = new Set(["object", "string", "null", "array", "boolean", "number", "integer"]);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function schemaObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalidSchema(location, message) { fail("invalid-schema", `${location}: ${message}`); }
export function validateSchemaDefinition(schema, location = "$", root = true) {
  if (!schemaObject(schema)) invalidSchema(location, "schema must be an object");
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(key)) invalidSchema(location, `unsupported schema keyword ${key}`);
  if (root && schema.$schema !== DRAFT_07) invalidSchema(location, `$schema must equal ${DRAFT_07}`);
  if (schema.$schema !== undefined && schema.$schema !== DRAFT_07) invalidSchema(location, `$schema must equal ${DRAFT_07}`);
  for (const key of ["$id", "title"]) if (schema[key] !== undefined && typeof schema[key] !== "string") invalidSchema(location, `${key} must be a string`);
  if (schema.type !== undefined && !SCHEMA_TYPES.has(schema.type)) invalidSchema(location, "type must be a supported type string");
  if (schema.properties !== undefined) { if (!schemaObject(schema.properties)) invalidSchema(location, "properties must be an object of schemas"); for (const [key, child] of Object.entries(schema.properties)) validateSchemaDefinition(child, `${location}.properties.${key}`, false); }
  if (schema.additionalProperties !== undefined) { if (typeof schema.additionalProperties !== "boolean" && !schemaObject(schema.additionalProperties)) invalidSchema(location, "additionalProperties must be boolean or schema object"); if (schemaObject(schema.additionalProperties)) validateSchemaDefinition(schema.additionalProperties, `${location}.additionalProperties`, false); }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string") || new Set(schema.required).size !== schema.required.length)) invalidSchema(location, "required must be a unique string array");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) invalidSchema(location, "enum must be a nonempty array");
  if (schema.pattern !== undefined) { if (typeof schema.pattern !== "string") invalidSchema(location, "pattern must be a string"); try { new RegExp(schema.pattern); } catch { invalidSchema(location, "pattern must compile"); } }
  if (schema.minItems !== undefined && (!Number.isInteger(schema.minItems) || schema.minItems < 0)) invalidSchema(location, "minItems must be a nonnegative integer");
  if (schema.items !== undefined) { if (!schemaObject(schema.items)) invalidSchema(location, "items must be a schema object"); validateSchemaDefinition(schema.items, `${location}.items`, false); }
  return schema;
}
function schemaType(value, type) { if (type === "null") return value === null; if (type === "array") return Array.isArray(value); if (type === "object") return schemaObject(value); if (type === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value); return typeof value === type; }
export function validateSchema(value, schema, location = "$") {
  validateSchemaDefinition(schema, location, location === "$");
  if (schema.type !== undefined && !schemaType(value, schema.type)) fail("schema-validation", `${location}: expected ${schema.type}`);
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) fail("schema-validation", `${location}: expected constant ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) fail("schema-validation", `${location}: value is not in enum`);
  if (schema.pattern !== undefined && (typeof value !== "string" || !(new RegExp(schema.pattern).test(value)))) fail("schema-validation", `${location}: does not match ${schema.pattern}`);
  if (schema.required !== undefined) { if (!schemaType(value, "object")) fail("schema-validation", `${location}: required requires object`); for (const key of schema.required) if (!(key in value)) fail("schema-validation", `${location}: missing required ${key}`); }
  if (schemaType(value, "object")) { const properties = schema.properties ?? {}; for (const [key, item] of Object.entries(value)) { if (key in properties) validateSchema(item, properties[key], `${location}.${key}`); else if (schema.additionalProperties === false) fail("schema-validation", `${location}: additional property ${key}`); else if (schemaObject(schema.additionalProperties)) validateSchema(item, schema.additionalProperties, `${location}.${key}`); } }
  if (schemaType(value, "array")) { if (schema.minItems !== undefined && value.length < schema.minItems) fail("schema-validation", `${location}: expected at least ${schema.minItems} items`); if (schema.items !== undefined) for (let index = 0; index < value.length; index += 1) validateSchema(value[index], schema.items, `${location}[${index}]`); }
  return value;
}
