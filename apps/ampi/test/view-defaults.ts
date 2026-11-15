import type { ViewName, ViewTopic, ViewValue } from "../src/shared/protocol.ts";

// The value a scripted hub publishes for a view topic its test does not drive. A reader assumes its view's shape, so
// `{}` breaks the App; the Timeline page that `/` opens reads cos.timeline from every reader Host. Each view gets a
// valid value here, and a new view fails tsc until it has one.
const NOT_IN_TEST = (view: string) => ({ error: { code: "view_failed" as const, message: `${view} is not in this test` } });

export const VIEW_DEFAULTS: { [K in ViewName]: ViewValue<K> } = {
	"cos.timeline": { bucketMs: 60_000, sessions: [] },
	rarebit: NOT_IN_TEST("rarebit"),
	team: NOT_IN_TEST("team"),
	arc: NOT_IN_TEST("arc"),
};

/** The snapshot value for a topic the test does not script: a view's default, otherwise `{}`. */
export function unscriptedValue(topic: { kind?: string; view?: string } | undefined): unknown {
	return topic?.kind === "view" ? VIEW_DEFAULTS[(topic as ViewTopic).view] : {};
}
