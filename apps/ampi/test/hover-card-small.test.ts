import "./bound.ts";
import { firstFrameCases } from "./hover-card-fixture.ts";

// Hover card placement (hover-card-fixture.ts) on the first painted frame in the small viewports.
// hover-card-placement.test.ts holds the large viewports.
firstFrameCases([[900, 600], [1280, 420]]);
