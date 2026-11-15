import "./bound.ts";
import { AXIS_MATRIX, phoneAxisTests } from "./phone-axis-fixture.ts";

// The exhaustive lane covers every weekday at 09:05, 11:00, 12:59, and 23:59 in both locales and engines.
phoneAxisTests(AXIS_MATRIX, [320], { shareRanges: false });
