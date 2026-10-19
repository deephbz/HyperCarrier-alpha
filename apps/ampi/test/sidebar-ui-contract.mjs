// Reusable browser assertions for sidebar layout invariants. Accepts a Playwright Page.
// The memory Team can move this into its verify-ampi journey when its owner confirms the destination.
export async function assertSidebarUiContract(page) {
	const before = await page.evaluate(() => {
		const scroller = document.querySelector(".side-scroll");
		const row = document.querySelector("[data-leader-row] .row");
		const count = row?.querySelector("[data-worker-count]");
		if (!scroller || !row || !count) throw new Error("Sidebar Team fixture is missing");
		const rowBox = row.getBoundingClientRect();
		const countBox = count.getBoundingClientRect();
		return { width: rowBox.width, right: rowBox.right, countRight: countBox.right };
	});
	await page.evaluate(() => {
		const scroller = document.querySelector(".side-scroll");
		const style = document.createElement("style");
		style.textContent = ".side-scroll::-webkit-scrollbar { width: 15px }";
		document.head.append(style);
		for (let i = 0; i < 40; i++) {
			const row = document.createElement("div");
			row.className = "row";
			row.textContent = `Synthetic overflow row ${i}`;
			scroller.append(row);
		}
	});
	const after = await page.evaluate(() => {
		const scroller = document.querySelector(".side-scroll");
		const row = document.querySelector("[data-leader-row] .row");
		const count = row?.querySelector("[data-worker-count]");
		const rowBox = row.getBoundingClientRect();
		const countBox = count.getBoundingClientRect();
		return { width: rowBox.width, right: rowBox.right, countRight: countBox.right, overflow: scroller.scrollHeight > scroller.clientHeight };
	});
	if (!after.overflow) throw new Error("Synthetic rows did not cause sidebar overflow");
	for (const key of ["width", "right", "countRight"]) {
		if (before[key] !== after[key]) throw new Error(`${key} changed when sidebar overflow appeared: ${before[key]} → ${after[key]}`);
	}
	const child = page.locator('[data-row-level="2"] .title').first();
	if (await child.count()) throw new Error("Expected workers to start collapsed");
	await page.locator('[data-collapse-toggle]').first().click();
	const indent = await page.evaluate(() => {
		const leader = document.querySelector('[data-team-role="lead"] .title').getBoundingClientRect();
		const worker = document.querySelector('[data-row-level="2"] .title').getBoundingClientRect();
		return worker.x - leader.x;
	});
	if (indent < 12) throw new Error(`Worker indent is ${indent}px; expected at least 12px`);
	const repeated = await page.evaluate(() => {
		const leader = document.querySelector('[data-team-role="lead"] .title').textContent.trim().toLowerCase();
		return [...document.querySelectorAll('[data-row-level="2"] .title')].some((el) => el.textContent.trim().toLowerCase().includes(leader));
	});
	if (repeated) throw new Error("A worker label repeats its leader label");
	if (await page.locator(".idle-dot").count()) throw new Error("An idle row renders a constant marker");
	return { overflow: "stable", indent, repeatedLeaderLabel: false, idleMarkers: 0 };
}
