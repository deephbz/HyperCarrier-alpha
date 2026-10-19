// UI invariant rules: one class-level check per owner report class (features/ui-invariants.md rows a–f).
// Each check runs inside the page through page.evaluate(check, options) and returns findings:
//   { row, rule, at, detail }   where `at` is a short, stable element descriptor.
// Checks are self-contained functions: they may not close over module scope.
// Selectors prefer the hc-lenses data-* contract and fall back to the classes of earlier builds, so a seed can
// be checked on its pre-fix commit.

/** Row a, part 1: record layout shifts that no user input caused. Install with context.addInitScript. */
export function observeLayoutShifts() {
  window.__uiShifts = [];
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__uiShifts.push({ at: e.startTime, value: e.value, sources: (e.sources ?? []).map(s => s.node?.nodeType === 1 ? s.node.outerHTML.slice(0, 80) : String(s.node?.nodeName ?? '')) });
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

/** Row a, part 1: shifts after `since` (performance.now() ms) sum to zero. */
export function layoutShiftsSince({ since }) {
  const shifts = (window.__uiShifts ?? []).filter(s => s.at > since);
  const total = shifts.reduce((n, s) => n + s.value, 0);
  return total > 0 ? [{ row: 'a', rule: 'cls-zero', at: 'document', detail: `CLS ${total.toFixed(4)} without user input: ${JSON.stringify(shifts.slice(0, 3))}` }] : [];
}

/**
 * Row a needs real scrollbars. Playwright's headless Chrome passes --hide-scrollbars, which makes every scrollbar
 * 0 px wide whatever the CSS says. Launch with these options.
 */
export const SCROLLBAR_LAUNCH = { ignoreDefaultArgs: ['--hide-scrollbars'] };

/** Forces classic (space-taking) scrollbars, as on Windows, Linux and macOS with a mouse attached. */
export const CLASSIC_SCROLLBARS = '*::-webkit-scrollbar { width: 15px; height: 15px } *::-webkit-scrollbar-thumb { background: #8888 }';

/**
 * Row a, part 2: a scroll container's rows keep their x and width when its scrollbar appears or goes.
 * For each visible vertical scroller, flip it between "no overflow" and "overflow", then compare the boxes of its
 * row-like descendants. Restores the DOM afterwards.
 */
export function scrollbarStability({ rowSelector, tolerance = 0.5, limit = 40 }) {
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 3).map(c => '.' + c).join('') +
    [...el.attributes].filter(a => a.name.startsWith('data-')).slice(0, 2).map(a => `[${a.name}=${JSON.stringify(a.value)}]`).join('');
  const findings = [];
  const scrollers = [...document.querySelectorAll('*')].filter(el => {
    const s = getComputedStyle(el), b = el.getBoundingClientRect();
    return /(auto|scroll)/.test(s.overflowY) && b.width > 60 && b.height > 60 && s.visibility !== 'hidden' && !el.closest('[inert]');
  });
  for (const scroller of scrollers) {
    // A row belongs to its nearest scroller only; an outer scroller would repeat the same finding.
    const rows = [...scroller.querySelectorAll(rowSelector)].filter(r => r.getBoundingClientRect().width > 0 && scrollers.find(o => o !== scroller && scroller.contains(o) && o.contains(r)) === undefined).slice(0, limit);
    if (!rows.length) continue;
    const boxes = () => rows.map(r => { const b = r.getBoundingClientRect(); return { left: b.left, width: b.width }; });
    const overflowing = scroller.scrollHeight > scroller.clientHeight;
    const top = scroller.scrollTop;
    let undo;
    // Measure "without scrollbar" and "with scrollbar" in a fixed order, whatever the current state is.
    const without = () => { const prev = scroller.style.overflowY; scroller.style.overflowY = 'hidden'; return () => { scroller.style.overflowY = prev; }; };
    const withBar = () => { const spacer = document.createElement('div'); spacer.style.height = `${scroller.clientHeight * 2 + 200}px`; spacer.dataset.uiInvariantSpacer = ''; scroller.append(spacer); return () => spacer.remove(); };
    let a, b;
    if (overflowing) { undo = without(); a = boxes(); undo(); b = boxes(); }
    else { a = boxes(); undo = withBar(); b = boxes(); undo(); }
    scroller.scrollTop = top;
    rows.forEach((r, i) => {
      const dx = Math.abs(a[i].left - b[i].left), dw = Math.abs(a[i].width - b[i].width);
      if (dx > tolerance || dw > tolerance) findings.push({ row: 'a', rule: 'scrollbar-stable', at: `${name(scroller)} > ${name(r)}`, detail: `scrollbar ${overflowing ? 'present' : 'appearing'} moves the row: Δx ${dx.toFixed(1)} px, Δwidth ${dw.toFixed(1)} px` });
    });
  }
  // One finding per scroller is enough to locate the class; keep the first row as the example.
  const seen = new Set();
  return findings.filter(f => { const key = f.at.split(' > ')[0]; if (seen.has(key)) return false; seen.add(key); return true; });
}

/** Row a, part 3: the x and width of each keyed row, for a before/after diff across a state change. */
export function rowBoxes({ rowSelector, key }) {
  return Object.fromEntries([...document.querySelectorAll(rowSelector)].map(r => { const b = r.getBoundingClientRect(); return [r.getAttribute(key), { left: Math.round(b.left * 2) / 2, width: Math.round(b.width * 2) / 2 }]; }).filter(([k, b]) => k && b.width));
}

/** Text start x of an element: the first non-empty text node's first client rect, else the element's left edge. */
const textStart = String.raw`(el => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const node = walker.nextNode();
  if (!node) return el.getBoundingClientRect().left;
  const range = document.createRange(); range.selectNodeContents(node);
  const rect = range.getClientRects()[0];
  return rect ? rect.left : el.getBoundingClientRect().left;
})`;

/**
 * Hierarchy pairs: each child row with its parent row. The contract is [data-row-level="2"] with
 * [data-parent-leader]; earlier builds mark children with `.row.child` after their parent row.
 */
function hierarchyPairs({ rowSelector, childSelector, labelSelector }) {
  const rows = [...document.querySelectorAll(rowSelector)].filter(r => r.getBoundingClientRect().width > 0);
  const pairs = [];
  let parent = null;
  for (const r of rows) {
    if (r.matches(childSelector)) { if (parent) pairs.push([parent, r]); }
    else parent = r;
  }
  const label = r => (r.querySelector(labelSelector) ?? r).innerText.trim();
  return pairs.map(([p, c]) => ({ parent: p, child: c, parentLabel: label(p), childLabel: label(c) }));
}

/** Row b: a child's text starts at least `indent` px right of its parent's text. */
export function childIndent({ rowSelector, childSelector, labelSelector, indent = 12, pairsSource, textStartSource }) {
  const pairs = (0, eval)(pairsSource)({ rowSelector, childSelector, labelSelector });
  const start = (0, eval)(textStartSource);
  return pairs.flatMap(({ parent, child, parentLabel, childLabel }) => {
    const dx = start(child.querySelector(labelSelector) ?? child) - start(parent.querySelector(labelSelector) ?? parent);
    return dx + 0.5 < indent ? [{ row: 'b', rule: 'child-indent', at: `${JSON.stringify(childLabel.slice(0, 40))} under ${JSON.stringify(parentLabel.slice(0, 40))}`, detail: `child text starts ${dx.toFixed(1)} px right of its parent text; at least ${indent} px required` }] : [];
  });
}

/**
 * Row c: a label does not repeat its parent's label or the parent's leading segment.
 * Segments split on "/", "·", ":", "|", " - " and " — ".
 */
export function labelRepeat({ rowSelector, childSelector, labelSelector, groupSelector, groupLabelSelector, pairsSource }) {
  const pairs = (0, eval)(pairsSource)({ rowSelector, childSelector, labelSelector });
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const head = s => norm(s).split(/\s*(?:\/|·|:|\||\s-\s|\s—\s)\s*/)[0];
  const findings = [];
  const check = (childLabel, parentLabel, at) => {
    const c = norm(childLabel), p = norm(parentLabel), ph = head(parentLabel);
    if (!c || !p) return;
    if (c.includes(p) && p.length >= 3) findings.push({ row: 'c', rule: 'label-repeat', at, detail: `"${childLabel.slice(0, 60)}" repeats its parent label "${parentLabel.slice(0, 40)}"` });
    else if (ph.length >= 3 && head(childLabel) !== c && head(childLabel) === ph) findings.push({ row: 'c', rule: 'label-prefix', at, detail: `"${childLabel.slice(0, 60)}" repeats its parent's leading segment "${ph}"` });
    else if (ph.length >= 3 && c.split(/\s*(?:\/|·|:|\||\s-\s|\s—\s)\s*/).slice(1).some(seg => seg === ph || seg.startsWith(ph + '/'))) findings.push({ row: 'c', rule: 'label-prefix', at, detail: `"${childLabel.slice(0, 60)}" repeats its parent's leading segment "${ph}"` });
  };
  for (const { childLabel, parentLabel } of pairs) check(childLabel, parentLabel, `${JSON.stringify(childLabel.slice(0, 40))} under ${JSON.stringify(parentLabel.slice(0, 40))}`);
  if (groupSelector) for (const g of document.querySelectorAll(groupSelector)) {
    const gl = g.querySelector(groupLabelSelector)?.innerText.trim() ?? '';
    for (const r of g.querySelectorAll(rowSelector)) {
      const rl = (r.querySelector(labelSelector) ?? r).innerText.trim();
      check(rl, gl.replace(/\s*\(\d[\d,]*\)$/, ''), `${JSON.stringify(rl.slice(0, 40))} in group ${JSON.stringify(gl.slice(0, 40))}`);
    }
  }
  return findings;
}

/**
 * Row d: a status mark carries information. In a list of at least `min` rows, a list where every row carries a
 * mark, or one mark appearance on more than `share` of the rows, has a constant marker (the resting state needs
 * no mark).
 */
export function constantStatusMark({ listSelector, rowSelector, markSelector, min = 3, share = 0.5 }) {
  const findings = [];
  for (const list of document.querySelectorAll(listSelector)) {
    const rows = [...list.querySelectorAll(rowSelector)].filter(r => r.getBoundingClientRect().width > 0);
    if (rows.length < min) continue;
    const looks = new Map();
    let marked = 0;
    for (const r of rows) for (const [i, m] of [...r.querySelectorAll(markSelector)].entries()) {
      const s = getComputedStyle(m), b = m.getBoundingClientRect();
      if (!b.width || s.visibility === 'hidden' || s.display === 'none') continue;
      if (i === 0 || ![...r.querySelectorAll(markSelector)].slice(0, i).some(x => x.getBoundingClientRect().width)) marked++;
      const look = [m.className.baseVal ?? m.className, s.backgroundColor, s.borderColor, s.color, Math.round(b.width), Math.round(b.height)].join('|');
      looks.set(look, (looks.get(look) ?? 0) + 1);
    }
    // The resting state needs no mark: when every row carries one, one of the marks says nothing.
    if (marked === rows.length) findings.push({ row: 'd', rule: 'every-row-marked', at: listSelector, detail: `all ${rows.length} rows carry a status mark; looks ${[...looks.keys()].map(l => l.split('|')[0]).join(', ')}` });
    else for (const [look, n] of looks) if (n > rows.length * share && n >= min) findings.push({ row: 'd', rule: 'constant-mark', at: look.split('|')[0] || 'mark', detail: `the same mark (${look}) shows on ${n} of ${rows.length} rows` });
  }
  return findings;
}

/** Row e: an open popover, menu, tooltip, card or dialog lies inside the viewport and inside every clipping ancestor. */
export function popoverContained({ popoverSelector, tolerance = 1 }) {
  const name = el => el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map(c => '.' + c).join('') + (el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '');
  const findings = [];
  for (const el of document.querySelectorAll(popoverSelector)) {
    const s = getComputedStyle(el), b = el.getBoundingClientRect();
    if (!b.width || !b.height || s.visibility === 'hidden' || s.display === 'none' || el.closest('[inert]')) continue;
    const out = [b.left < -tolerance && 'left', b.top < -tolerance && 'top', b.right > innerWidth + tolerance && 'right', b.bottom > innerHeight + tolerance && 'bottom'].filter(Boolean);
    if (out.length) findings.push({ row: 'e', rule: 'in-viewport', at: name(el), detail: `extends past the viewport ${out.join(', ')}: ${JSON.stringify({ left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), vw: innerWidth, vh: innerHeight })}` });
    // Each visible corner must hit the element itself. This catches clipping and a sibling layer painted on top.
    const corners = [[b.left + 2, b.top + 2, 'top-left'], [b.right - 2, b.top + 2, 'top-right'], [b.left + 2, b.bottom - 2, 'bottom-left'], [b.right - 2, b.bottom - 2, 'bottom-right']]
      .filter(([x, y]) => x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight);
    const hidden = corners.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit && !el.contains(hit); });
    if (hidden.length) findings.push({ row: 'e', rule: 'corner-hidden', at: name(el), detail: `${hidden.map(([x, y, c]) => `${c} shows ${name(document.elementFromPoint(x, y))}`).join('; ')}` });
    // A fixed element escapes ancestor overflow unless an ancestor creates its containing block.
    const fixed = s.position === 'fixed';
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (fixed && as.transform === 'none' && as.filter === 'none' && !/paint|layout|strict|content/.test(as.contain)) continue;
      if (!/(hidden|auto|scroll|clip)/.test(as.overflowX + as.overflowY)) continue;
      const ab = a.getBoundingClientRect();
      const cut = [/(hidden|auto|scroll|clip)/.test(as.overflowX) && (b.left < ab.left - tolerance || b.right > ab.right + tolerance) && 'x', /(hidden|auto|scroll|clip)/.test(as.overflowY) && (b.top < ab.top - tolerance || b.bottom > ab.bottom + tolerance) && 'y'].filter(Boolean);
      if (cut.length) { findings.push({ row: 'e', rule: 'not-clipped', at: name(el), detail: `clipped on ${cut.join(', ')} by ${name(a)} (overflow ${as.overflowX}/${as.overflowY})` }); break; }
    }
  }
  return findings;
}

/**
 * Row f: no two visible text boxes overlap. Compares line boxes of HTML text and SVG <text>, clipped to the
 * viewport and to scrolling ancestors. Layers are separate: text inside an overlay is compared only with text in
 * the same overlay.
 */
export function textOverlap({ overlaySelector, minArea = 4, minShare = 0.15, limit = 4000 }) {
  const boxes = [];
  const clipOf = el => {
    let c = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    // Start at the text's own element: an eliding label clips its own text.
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (!/(hidden|auto|scroll|clip)/.test(s.overflowX + s.overflowY)) continue;
      const b = a.getBoundingClientRect();
      if (/(hidden|auto|scroll|clip)/.test(s.overflowX)) { c.left = Math.max(c.left, b.left); c.right = Math.min(c.right, b.right); }
      if (/(hidden|auto|scroll|clip)/.test(s.overflowY)) { c.top = Math.max(c.top, b.top); c.bottom = Math.min(c.bottom, b.bottom); }
    }
    return c;
  };
  const visible = el => {
    if (el.closest('[inert],[aria-hidden="true"]')) return false;
    // A closed <details> keeps its body laid out under content-visibility: hidden; it is not on screen.
    const closed = el.closest('details:not([open])');
    if (closed && !el.closest('summary')?.parentElement?.isSameNode(closed)) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; }
    return true;
  };
  const add = (el, rect, text) => {
    const c = clipOf(el);
    const r = { left: Math.max(rect.left, c.left), top: Math.max(rect.top, c.top), right: Math.min(rect.right, c.right), bottom: Math.min(rect.bottom, c.bottom) };
    if (r.right - r.left < 1 || r.bottom - r.top < 1) return;
    boxes.push({ el, r, text: text.trim().slice(0, 30), layer: el.closest(overlaySelector) });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim() && n.parentElement && !n.parentElement.closest('svg,script,style,textarea') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const seen = new Map();
  for (let n = walker.nextNode(); n && boxes.length < limit; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!seen.has(el)) seen.set(el, visible(el));
    if (!seen.get(el)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    for (const rect of range.getClientRects()) add(el, rect, n.textContent);
  }
  for (const t of document.querySelectorAll('svg text')) if (t.textContent.trim() && visible(t)) add(t, t.getBoundingClientRect(), t.textContent);
  const findings = [];
  const key = (a, b) => [a.text, b.text].sort().join('|');
  const reported = new Set();
  boxes.sort((a, b) => a.r.left - b.r.left);
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length && boxes[j].r.left < a.r.right; j++) {
      const b = boxes[j];
      if (a.el === b.el || a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 0 || h <= 0) continue;
      const area = w * h, smaller = Math.min((a.r.right - a.r.left) * (a.r.bottom - a.r.top), (b.r.right - b.r.left) * (b.r.bottom - b.r.top));
      if (area < minArea || area < smaller * minShare || reported.has(key(a, b))) continue;
      reported.add(key(a, b));
      const name = el => el.tagName.toLowerCase() + [...(el.classList ?? [])].slice(0, 2).map(c => '.' + c).join('');
      findings.push({ row: 'f', rule: 'text-overlap', at: `${name(a.el)} × ${name(b.el)}`, detail: `"${a.text}" overlaps "${b.text}" by ${Math.round(w)}×${Math.round(h)} px` });
    }
  }
  return findings;
}

export const textStartSource = textStart;
export const pairsSource = `(${hierarchyPairs.toString()})`;

/** The AmPi selector contract. data-* first (hc-lenses sidebar), then the classes of earlier builds. */
export const AMPI = {
  rowSelector: '[data-row-level], .side-scroll .row[data-thread]',
  childSelector: '[data-row-level="2"], .row.child',
  labelSelector: '.title',
  groupSelector: '.side-scroll .group',
  groupLabelSelector: '.group-label',
  listSelector: '.side-scroll',
  markSelector: '.idle-dot, .spinner, [data-status-mark]',
  keyedRowSelector: '[data-thread]',
  rowKey: 'data-thread',
  popoverSelector: '[role=tooltip], [role=menu], [role=listbox], [role=dialog], .hover-card, .popover, [data-popover], .session-metadata',
  overlaySelector: '[role=dialog], [role=menu], [role=tooltip], [role=listbox], .hover-card, .popover, [data-popover], .session-metadata',
};

/** Runs every row a–f check on the current page state. `since` is the performance.now() mark for row a's CLS. */
export async function checkPage(page, { since = 0, rows = 'abcdef', contract = AMPI } = {}) {
  const c = contract, all = [];
  const run = async (row, fn, arg) => { if (rows.includes(row)) all.push(...await page.evaluate(fn, arg)); };
  await run('a', layoutShiftsSince, { since });
  await run('a', scrollbarStability, { rowSelector: c.rowSelector });
  await run('b', childIndent, { rowSelector: c.rowSelector, childSelector: c.childSelector, labelSelector: c.labelSelector, pairsSource, textStartSource });
  await run('c', labelRepeat, { rowSelector: c.rowSelector, childSelector: c.childSelector, labelSelector: c.labelSelector, groupSelector: c.groupSelector, groupLabelSelector: c.groupLabelSelector, pairsSource });
  await run('d', constantStatusMark, { listSelector: c.listSelector, rowSelector: c.rowSelector, markSelector: c.markSelector });
  await run('e', popoverContained, { popoverSelector: c.popoverSelector });
  await run('f', textOverlap, { overlaySelector: c.overlaySelector });
  return all;
}
