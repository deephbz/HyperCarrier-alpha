import "./bound.ts";
import { AXIS_TIMES, phoneAxisTests } from "./phone-axis-fixture.ts";

// The fast lane covers the pinned axis times at every phone width in both locales and engines. phone-layout.test.ts
// held these cases until the two together outgrew the per-file bound on hosted macOS WebKit.
phoneAxisTests(AXIS_TIMES);
