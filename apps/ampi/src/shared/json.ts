// Strict JSON, the value shape of view fields that carry opaque Pi data. Structurally equal to chord's JsonValue,
// so chord's delta helpers accept it.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
