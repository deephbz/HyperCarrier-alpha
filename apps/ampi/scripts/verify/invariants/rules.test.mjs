#!/usr/bin/env node
// Each UI invariant rule turns red on a synthetic copy of its seed and green on the fixed copy.
// One Chrome page, no hub:  node apps/ampi/scripts/verify/invariants/rules.test.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { AMPI, CLASSIC_SCROLLBARS, SCROLLBAR_LAUNCH, checkPage, observeLayoutShifts } from './rules.mjs';

// Shapes copied from the AmPi sidebar at 39b5240 (seed) and dev/hc-lenses-sidebar 2361d04 (fix).
const sidebar = ({ gutter, childPad, workerLabel, idleDot }) => `
<style>
  body { margin: 0; font: 13px system-ui; }
  .side-scroll { height: 300px; width: 260px; overflow-y: auto; ${gutter ? 'scrollbar-gutter: stable;' : ''} padding: 4px 8px; }
  .row { display: flex; align-items: center; gap: 6px; height: 26px; padding-left: 8px; }
  .row.child { padding-left: ${childPad}px; }
  .twisty { width: 12px; display: inline-block; }
  .idle-dot { width: 6px; height: 6px; border-radius: 3px; background: #999; display: inline-block; }
  .spinner { width: 10px; height: 10px; border: 2px solid #36c; border-radius: 50%; display: inline-block; }
  .title { flex: 1; overflow: hidden; white-space: nowrap; }
</style>
<div class="side-scroll"><div class="group"><span class="group-label">hc-lenses</span>
  <div class="row" data-thread="lead" data-row-level="1"><span class="twisty">▾</span>${idleDot ? '<span class="idle-dot"></span>' : ''}<a class="title">team/lens lead</a></div>
  ${['reader', 'gui', 'tests'].map((w, i) => `<div class="row child" data-thread="${w}" data-row-level="2">${i === 0 ? '<span class="spinner"></span>' : idleDot ? '<span class="idle-dot"></span>' : ''}<a class="title">${workerLabel(w)}</a></div>`).join('')}
  <div class="row" data-thread="solo" data-row-level="1"><span class="twisty"></span>${idleDot ? '<span class="idle-dot"></span>' : ''}<a class="title">solo</a></div>
</div></div>`;
const seedSidebar = sidebar({ gutter: false, childPad: 24, workerLabel: w => `<b>${w}</b> · team/lens ${w}`, idleDot: true });
const fixSidebar = sidebar({ gutter: true, childPad: 40, workerLabel: w => `<b>${w}</b>`, idleDot: false });

// Row e: a hover card anchored inside a clipping composer (seed) and portalled to the body (fix).
const card = portal => `
<style> body { margin: 0; } .composer { position: absolute; bottom: 0; left: 0; width: 600px; height: 60px; overflow: hidden; }
  .hover-card { position: absolute; width: 280px; height: 160px; background: #eee; } </style>
<div class="composer">${portal ? '' : '<div class="hover-card" role="tooltip" style="bottom: 40px; left: 10px">model card</div>'}</div>
${portal ? '<div class="hover-card" role="tooltip" style="position: fixed; bottom: 70px; left: 10px">model card</div>' : ''}`;

// Row f: lane labels at a fixed x step that overlap at 1024 (seed) and labels that elide (fix).
const labels = elide => `
<style> body { margin: 0; font: 12px system-ui; } .lane { position: relative; height: 20px; width: 1000px; }
  .cos-band-label { position: absolute; top: 2px; white-space: nowrap; ${elide ? 'max-width: 110px; overflow: hidden; text-overflow: ellipsis;' : ''} } </style>
<div class="lane">${['reader · sidebar decision pending', 'gui · Timeline brush and totals', 'tests · journey runner budget'].map((t, i) => `<span class="cos-band-label" style="left: ${i * 120}px">${t}</span>`).join('')}</div>`;

// Row a, CLS: a banner inserted above content after load, without input (seed), and a reserved slot (fix).
const shift = reserved => `
<style> body { margin: 0; font: 13px system-ui; } .slot { ${reserved ? 'height: 40px;' : ''} } </style>
<div class="slot" id="slot"></div><p>Session list</p><p>Timeline</p>
<script> setTimeout(() => { const b = document.createElement('div'); b.style.height = '40px'; b.textContent = 'Host connected'; document.getElementById('slot').append(b); }, 300); </script>`;

const channel = process.env.UX_CHROME_CHANNEL;
const browser = await chromium.launch({ headless: true, ...SCROLLBAR_LAUNCH, ...(channel ? { channel } : {}) });
const cases = [];
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 700 } });
  const page = await context.newPage();
  const check = async (name, html, rows, expectRows) => {
    await page.setContent(`<!doctype html><html><head><style>${CLASSIC_SCROLLBARS}</style></head><body>${html}</body></html>`);
    // setContent reuses the window, so install the shift observer again; `buffered` keeps earlier entries,
    // so count only shifts after this case's content is in.
    await page.evaluate(observeLayoutShifts);
    const since = await page.evaluate(() => performance.now());
    await page.waitForTimeout(rows.includes('a') ? 600 : 50);
    const findings = await checkPage(page, { since, rows });
    const got = [...new Set(findings.map(f => f.row))].sort().join('');
    cases.push({ name, expect: expectRows || 'green', got: got || 'green', findings: findings.map(f => `${f.row}/${f.rule} ${f.at}: ${f.detail}`) });
    assert.equal(got, expectRows, `${name}: ${JSON.stringify(findings, null, 1)}`);
  };
  await check('sidebar seed (39b5240 shape)', seedSidebar, 'abcd', 'abcd');
  await check('sidebar fix (2361d04 shape)', fixSidebar, 'abcd', '');
  await check('hover card seed (clipped by composer)', card(false), 'e', 'e');
  await check('hover card fix (portal)', card(true), 'e', '');
  await check('timeline labels seed (overlap at 1024)', labels(false), 'f', 'f');
  await check('timeline labels fix (elided)', labels(true), 'f', '');
  // Row f must ignore text laid out inside a closed <details> (collapsed Thinking, Builds).
  await check('closed details body (not on screen)', `<style> body { margin: 0; font: 12px system-ui } .body { position: absolute; top: 32px; left: 0 } </style>
<details><summary>Thinking</summary><div class="body">Let me look at the files first</div></details><p style="position: absolute; top: 32px; margin: 0">Looking at step 43</p>`, 'f', '');
  await check('layout shift seed (late banner)', shift(false), 'a', 'a');
  await check('layout shift fix (reserved slot)', shift(true), 'a', '');
  // The real sidebar uses AMPI selectors; keep this test on the same contract.
  assert.equal(AMPI.childSelector, '[data-row-level="2"], .row.child');
} finally {
  await browser.close();
  for (const c of cases) console.log(`${c.got === c.expect ? 'ok  ' : 'FAIL'} ${c.name}: expected ${c.expect}, got ${c.got}${c.findings.length ? '\n      ' + c.findings.join('\n      ') : ''}`);
}
