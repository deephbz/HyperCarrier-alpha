// The web UI registration file: the one web file another line edits to register components (scripts/lines-footprint.allow).
// It fills the slot registries in slot-registry.ts. Only the app entry (main.tsx) loads it, before the first render, so a
// registered kind module may import any main component. Main registers nothing. Node tests read the pure extensions.ts.

import "./slot-registry.ts";
