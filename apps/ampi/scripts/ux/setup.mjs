// Purpose: drive one recipe's setup step (recipes.mjs `setup`) on a loaded AmPi page.
// Shared by the wireflow capture, the UI invariant runner and the preview, so all reach the same states.
// `ctx.demo` is the disposable demo directory; a step may write a fixture precondition there, never a user action.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const button = (p, name) => p.getByRole('button', { name, exact: true });
let arrivals = 0;
/** Fixture precondition: 1 user prompt, 1 assistant reply with prose, and 5 tool uses arrive in a demo Session. */
const BATCH = { messages: 2, tools: 5 };
function arrive(file) {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  let parent = JSON.parse(lines.at(-1)).id, n = 0;
  const batch = ++arrivals;
  const at = new Date(JSON.parse(lines.at(-1)).timestamp ?? Date.now()).getTime();
  const row = message => { const id = `preview-arrive-${batch}-${++n}`; appendFileSync(file, JSON.stringify({ type: 'message', id, parentId: parent, timestamp: new Date(at + n * 1000).toISOString(), message: { timestamp: at + n * 1000, ...message } }) + '\n'); parent = id; };
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
  row({ role: 'user', content: [{ type: 'text', text: 'Synthetic follow-up: check the reader once more.' }] });
  row({ role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'toolUse', usage, content: [{ type: 'thinking', thinking: 'Check the files.' }, ...[1, 2, 3, 4].map(i => ({ type: 'toolCall', id: `preview-call-${batch}-${i}`, name: 'bash', arguments: { command: `echo step ${i}` } }))] });
  for (const i of [1, 2, 3, 4]) row({ role: 'toolResult', toolCallId: `preview-call-${batch}-${i}`, toolName: 'bash', content: [{ type: 'text', text: `step ${i}` }], isError: false });
  row({ role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'stop', usage, content: [{ type: 'text', text: 'Synthetic reply: the reader is ready.' }] });
}
/** A scene's place is its `read` entry: settled when AmPi has revealed it and the reveal is no longer busy. */
const read = (p, id) => p.waitForFunction(id => {
  const transcript = document.querySelector('[data-region="transcript"]');
  return transcript && !transcript.hasAttribute('aria-busy') && transcript.querySelector(`[data-entry="${CSS.escape(id)}"].flash`);
}, id, { timeout: 15_000 });
const more = p => p.getByLabel('More actions', { exact: true }).click();
const composer = p => p.getByRole('textbox', { name: 'Message the agent', exact: true });
const phone = async p => {
  const hide = p.getByRole('button', { name: 'Hide sidebar', exact: true });
  // The click inerts the button that holds the focus; the App returns the focus to the Session (R11) a few frames later.
  if (await hide.isVisible()) { await hide.click(); await p.waitForFunction(() => document.activeElement !== document.body && !document.activeElement?.closest('[inert]')); }
  // The name slides under the pointer that pressed Hide sidebar; the scene shows the header, not its hover card.
  await p.mouse.move(195, 450);
};
const newDialog = async p => { await p.keyboard.press('Control+n'); await p.getByRole('dialog').waitFor(); };
const accounts = async (p, r, s) => {
  // A real app event opens the existing dialog; all account RPCs stay in the browser fixture.
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('ampi:accounts', { detail: 'devbox' })));
  await p.locator('[data-accounts]').waitFor();
  if (s === 'login' || s === 'oauth') { await button(p, s === 'login' ? 'Add API key' : 'Sign in (subscription)').click(); await p.locator('.login-flow').waitFor(); }
  if (s === 'accounts' && !r.pending) await p.locator(r.reject ? '.accounts .err-box' : '.provider').waitFor();
};
const lens = async p => { await p.getByRole('button', { name: 'Chat', exact: true }).click(); await p.locator('.rb-tools summary').first().waitFor(); };

/**
 * The setup steps a recipe may name, each `(page, recipe, ctx) => Promise`. A step drives the UI through its product
 * controls and returns on the state the scene shows. A recipe that names no step here fails its scene (setup throws).
 */
export const STEPS = {
  'new-below': async (p, r, ctx) => {
    // Entries arrive below the reader's `read` entry; the reader's window holds, so only the chip shows them. Settled
    // when the chip counts the whole batch.
    if (!ctx.demo) throw new Error('new-below needs the demo directory');
    arrive(join(ctx.demo, 'agent/sessions/--work-rarebit--/big.jsonl'));
    await p.locator('.new-below button', { hasText: `${BATCH.messages} new messages, ${BATCH.tools} tool use` }).waitFor({ timeout: 15_000 });
  },
  'expand-team': p => p.locator('button[data-collapse-toggle][aria-expanded="false"]').first().click(),
  // The RangeBrush narrows the 96 h Timeline to its last 24 h: the start handle moves 72 h later (Shift+ArrowRight is
  // one hour). Settled when the range starts 72 h later.
  zoom: async p => {
    const start = p.getByRole('slider', { name: 'Range start', exact: true });
    const to = Number(await start.getAttribute('aria-valuenow')) + 72 * 3_600_000;
    await start.focus();
    for (let i = 0; i < 72; i++) await p.keyboard.press('Shift+ArrowRight');
    await p.waitForFunction(to => Number(document.querySelector('[aria-label="Range start"]')?.getAttribute('aria-valuenow')) === to, to);
  },
  'hover-stream': p => p.locator('svg a[aria-label^="Open "]').first().hover(),
  archive: p => p.getByRole('button', { name: /^Show archived( \(\d+\))?$/ }).click(),
  'collapse-group': p => p.locator('.group-row').first().click(),
  'host-collapse': p => p.locator('.side-head').first().click(),
  'rail-hover': async p => { await p.locator('.prompt-rail').hover(); await p.locator('.prompt-outline').waitFor(); },
  'rb-top': p => button(p, '↑ Top').click(),
  'task-next': async p => { await button(p, 'Next').scrollIntoViewIfNeeded(); await button(p, 'Next').click(); await p.locator('.ptb-title').filter({ hasText: /^Synthetic coverage Task 100$/ }).waitFor(); },
  'team-diagnostics': async p => { await p.getByText('Read diagnostics', { exact: true }).scrollIntoViewIfNeeded(); await p.getByText('Read diagnostics', { exact: true }).click(); },
  draft: p => composer(p).fill('Synthetic draft: check the reader and report the next decision.'),
  more,
  phone,
  'phone-more': async p => { await phone(p); await more(p); },
  slash: p => composer(p).fill('/'),
  sidebar: p => p.keyboard.press('Control+b'),
  tool: async p => { const e = p.locator('.tool-head').last(); await e.scrollIntoViewIfNeeded(); await e.click(); },
  thinking: async p => { const e = p.locator('.thinking summary').last(); await e.scrollIntoViewIfNeeded(); await e.click(); },
  image: async p => {
    await p.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
    await p.locator('.attachments').waitFor();
  },
  send: async p => { await composer(p).fill('Synthetic message; never send to a real agent.'); await button(p, 'Send ↵').click(); await p.locator('.composer-feedback').waitFor(); },
  'hide-continuation': p => p.getByRole('button', { name: 'Hide continuations', exact: true }).click(),
  'rb-models': p => button(p, 'Models').click(),
  diagnosis: p => p.getByRole('button', { name: /^Diagnosis/ }).click(),
  lens,
  'lens-tools': async p => { await lens(p); await p.locator('.rb-tools summary').first().click(); },
  'rb-prev': p => p.getByLabel('Previous user message', { exact: true }).click(),
  'rb-next': async p => { await button(p, '↑ Top').click(); await p.getByLabel('Next user message', { exact: true }).click(); },
  ask: async (p, r) => { await p.getByRole('textbox', { name: 'Ask on the side', exact: true }).fill('What changed in this synthetic example?'); await button(p, 'Ask').click(); await p.locator(r.reject ? '.rb-band .rb-error' : '.rb-side').waitFor(); },
  'task-detail': p => p.locator('.ptb-task summary').first().click(),
  graph: p => button(p, 'Graph').click(),
  'graph-task': async p => { await button(p, 'Graph').click(); await p.locator('.ptb-node button').first().click(); },
  build: async (p, r) => { await button(p, 'Build arc').click(); await p.locator(r.reject ? '.cos-error' : '.cos-toolbar button:disabled').waitFor(); },
  'new-agent': newDialog,
  'new-workspace': async p => { await newDialog(p); await button(p, 'New workspace').click(); },
  'new-error': async p => { await newDialog(p); await p.getByLabel('Working directory', { exact: true }).fill('/work/demo'); await p.getByRole('dialog').getByRole('button', { name: /^Start/ }).click(); await p.getByRole('alert').waitFor(); },
  'close-agent': async p => { await more(p); await button(p, 'Close pane…').click(); },
  'close-error': async p => { await more(p); await button(p, 'Close pane…').click(); await button(p, 'Close pane').click(); await p.getByRole('alert').waitFor(); },
  resume: p => button(p, 'Resume').click(),
  'resume-error': async p => { await button(p, 'Resume').click(); await p.getByRole('dialog').getByRole('button', { name: 'Resume', exact: true }).click(); await p.getByRole('alert').waitFor(); },
  'host-setup': p => p.getByRole('button', { name: /^Remote host \(\?\)$/ }).first().click(),
  palette: p => p.keyboard.press('Control+k'),
  'palette-empty': async p => { await p.keyboard.press('Control+k'); await p.getByLabel('Find a Session').fill('synthetic-no-match'); },
  help: async p => { await p.locator('body').click({ position: { x: 1000, y: 10 } }); await p.keyboard.press('?'); },
  accounts: (p, r) => accounts(p, r, 'accounts'),
  login: (p, r) => accounts(p, r, 'login'),
  oauth: (p, r) => accounts(p, r, 'oauth'),
};
STEPS['send-error'] = STEPS.send;

/**
 * Waits until a Session page holds the focus it takes on open: the Composer, or the docked shell when the page opens
 * with it. The Composer and the shell each take the focus when they mount, and their mount order depends on two hub
 * replies; the scene clicks the shell so the shell holds the focus on every run.
 */
const openFocus = async p => {
  if (!await p.locator('.composer textarea').count()) return;
  const shell = /[?&]p=shell\b/.test(new URL(p.url()).hash);
  if (shell) { await p.locator('.term-dock .xterm').waitFor(); await p.locator('.term-dock .term-box').click(); }
  await p.waitForFunction(sel => document.activeElement?.closest(sel), shell ? '.term-dock .term-box' : '.composer textarea');
};

/**
 * Brings a loaded page to the recipe's state. A Session page is loaded when its open focus has settled, so no step and
 * no shot races that focus. Then the recipe's `read` place, then its `setup` step.
 */
export async function setup(p, r, ctx = {}) {
  await openFocus(p);
  if (r.read) await read(p, r.read);
  if (!r.setup) return;
  const step = STEPS[r.setup];
  if (!step) throw new Error(`${r.id}: unknown setup step '${r.setup}'`);
  await step(p, r, ctx);
}
