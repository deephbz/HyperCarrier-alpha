import "./bound.ts";
import { zoomCases } from "./thread-scroll-zoom-cases.ts";

// Display zoom 80 % (thread-scroll-zoom-cases.ts). thread-scroll-zoom.test.ts holds zoom 130 %.
zoomCases(0.8);
