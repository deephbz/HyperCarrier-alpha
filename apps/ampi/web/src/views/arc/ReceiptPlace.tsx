import { Component, createRef, type ReactNode } from "react";
import { capturePlace, restorePlace, type ReadingPlace } from "../../keep-place.ts";

type Snapshot = { scroller: HTMLElement; place: ReadingPlace; top: number };
/** Capture before React changes the receipt DOM, then restore the surviving reading anchor. */
export class ReceiptPlace extends Component<{ stamp?: string; children: ReactNode }> {
	root = createRef<HTMLDivElement>();
	getSnapshotBeforeUpdate(previous: Readonly<{ stamp?: string }>): Snapshot | null {
		if (previous.stamp === this.props.stamp) return null;
		const scroller = this.root.current?.closest<HTMLElement>(".panel-body, [data-arc-scroller]");
		return scroller ? { scroller, place: capturePlace(scroller, "[data-arc-place]", "data-arc-place", false), top: scroller.scrollTop } : null;
	}
	componentDidUpdate(_previous: unknown, _state: unknown, snapshot: Snapshot | null) {
		if (!snapshot) return;
		const { scroller, place, top } = snapshot;
		scroller.scrollTop = top;
		restorePlace(scroller, "[data-arc-place]", "data-arc-place", place);
	}
	render() { return <div ref={this.root} className="arc-panel" data-panel="arc">{this.props.children}</div>; }
}
