import "./bound.ts";
import { edgeCases } from "./resize-edges-fixture.ts";
// The resize gesture (resize-edges-fixture.ts) at two display scales. resize-edges-limits.test.ts holds the region
// sizes, the clamps and the overlay.
edgeCases([["display 100%", undefined], ["display 125%", { overall: 1.25 }]]);
