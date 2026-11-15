// The web registry: the one pure web file another line edits, to register its parts (scripts/lines-footprint.allow).
// Main registers nothing. Each seam adds its registry here with an empty main value. Node tests import this file
// through routes and labels, so it imports no component; UI slots register in extensions-ui.ts. keymap.ts and
// host-kinds.ts read these values as they load, so a registered file imports only types from them.

import type { HostKind } from "./host-kinds.ts";
import type { KeyBinding } from "./keymap.ts";
import { DURABLE_KEYS, DURABLE_KIND } from "./durable/kind.ts";

/** Host source kinds after PI_KIND (host-kinds.ts). */
export const hostKinds: HostKind[] = [DURABLE_KIND];

/** Key bindings after main's KEYMAP; their actions extend ExtraKeyActions (keymap.ts). */
export const keyBindings: KeyBinding[] = [...DURABLE_KEYS];
