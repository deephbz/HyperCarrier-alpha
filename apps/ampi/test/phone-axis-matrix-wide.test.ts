import "./bound.ts";
import { AXIS_MATRIX, phoneAxisTests } from "./phone-axis-fixture.ts";

// Keep each exhaustive browser file below the shared file timeout.
phoneAxisTests(AXIS_MATRIX, [375], { shareRanges: false });
