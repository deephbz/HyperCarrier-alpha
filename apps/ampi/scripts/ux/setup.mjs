// Purpose: drive one recipe's setup step (recipes.mjs `setup`) on a loaded AmPi page.
// Shared by the wireflow capture and the UI invariant runner, so both reach the same states.

const button = (p, name) => p.getByRole('button', { name, exact: true });
export async function setup(p, r) {
  const s = r.setup;
  if (!s) return;
  const more = async () => { await p.getByLabel('More actions', { exact: true }).click(); };
  if (s === 'zoom') await p.getByLabel('Zoom in', { exact: true }).click();
  if (s === 'hover-stream') await p.locator('svg a[aria-label^="Open "]').first().hover();
  if (s === 'filter' || s === 'filter-empty') await p.getByLabel('Filter Sessions', { exact: true }).fill(s === 'filter' ? 'reader' : 'synthetic-no-match');
  if (s === 'archive') await button(p, 'Show archived').click();
  if (s === 'collapse-group') await p.locator('.group-row').first().click();
  if (s === 'host-collapse') await p.locator('.side-head').first().click();
  if (s === 'transcript-top') await p.locator('.scroll').evaluate(e => { e.scrollTop = 0; });
  if (s === 'rb-top') await button(p, '↑ Top').click();
  if (s === 'task-next') { await button(p, 'Next').scrollIntoViewIfNeeded(); await button(p, 'Next').click(); await p.locator('.ptb-title').filter({ hasText: /^Synthetic coverage Task 100$/ }).waitFor(); }
  if (s === 'team-diagnostics') { await p.getByText('Read diagnostics', { exact: true }).scrollIntoViewIfNeeded(); await p.getByText('Read diagnostics', { exact: true }).click(); }
  if (s === 'draft') await p.getByRole('textbox', { name: 'Message the agent', exact: true }).fill('Synthetic draft: check the reader and report the next decision.');
  if (s === 'more') await more();
  if (s === 'slash') await p.getByRole('textbox', { name: 'Message the agent', exact: true }).fill('/');
  if (s === 'sidebar') await p.keyboard.press('Control+b');
  if (s === 'tool') { const e = p.locator('.tool-head').last(); await e.scrollIntoViewIfNeeded(); await e.click(); }
  if (s === 'thinking') { const e = p.locator('.thinking summary').last(); await e.scrollIntoViewIfNeeded(); await e.click(); }
  if (s === 'image') {
    await p.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
    await p.locator('.attachments').waitFor();
  }
  if (s === 'send' || s === 'send-error') { await p.getByRole('textbox', { name: 'Message the agent', exact: true }).fill('Synthetic message; never send to a real agent.'); await button(p, 'Send ↵').click(); await p.locator('.composer-feedback').waitFor(); }
  if (s === 'hide-continuation') await p.getByRole('button', { name: 'Hide continuations', exact: true }).click();
  if (s === 'rb-models') await button(p, 'Models').click();
  if (s === 'diagnosis') await p.getByRole('button', { name: /^Diagnosis/ }).click();
  if (s === 'lens' || s === 'lens-tools') {
    await p.getByRole('button', { name: 'Transcript lens: full transcript', exact: true }).click();
    await p.locator('.rb-tools summary').first().waitFor();
    if (s === 'lens-tools') await p.locator('.rb-tools summary').first().click();
  }
  if (s === 'rb-prev') await p.getByLabel('Previous user message', { exact: true }).click();
  if (s === 'rb-next') { await button(p, '↑ Top').click(); await p.getByLabel('Next user message', { exact: true }).click(); }
  if (s === 'recap-hide' || s === 'recap-reshow') {
    await button(p, 'Recap').click(); await button(p, 'Dismiss recap').waitFor();
    await button(p, 'Recap').click(); await button(p, 'Dismiss recap').waitFor({ state: 'hidden' });
    if (s === 'recap-reshow') { await button(p, 'Recap').click(); await button(p, 'Dismiss recap').waitFor(); }
  }
  if (s === 'recap') { await button(p, 'Recap').click(); await p.getByRole('button', { name: 'Dismiss recap' }).waitFor(); }
  if (s === 'ask') { await p.getByRole('textbox', { name: 'Ask on the side', exact: true }).fill('What changed in this synthetic example?'); await button(p, 'Ask').click(); await p.locator(r.reject ? '.rb-band .rb-error' : '.rb-side').waitFor(); }
  if (s === 'task-detail') await p.locator('.ptb-task summary').first().click();
  if (s === 'graph' || s === 'graph-task') { await button(p, 'Graph').click(); if (s === 'graph-task') await p.locator('.ptb-node button').first().click(); }
  if (s === 'build') { await button(p, 'Build arc').click(); await p.locator(r.reject ? '.cos-error' : '.cos-toolbar button:disabled').waitFor(); }
  if (['new-agent', 'new-workspace', 'new-error'].includes(s)) {
    await p.keyboard.press('Control+n'); await p.getByRole('dialog').waitFor();
    if (s === 'new-workspace') await button(p, 'New workspace').click();
    if (s === 'new-error') { await p.getByLabel('Working directory', { exact: true }).fill('/work/demo'); await p.getByRole('dialog').getByRole('button', { name: /^Start/ }).click(); await p.getByRole('alert').waitFor(); }
  }
  if (s === 'close-agent' || s === 'close-error') { await more(); await button(p, 'Close pane…').click(); if (s === 'close-error') { await button(p, 'Close pane').click(); await p.getByRole('alert').waitFor(); } }
  if (s === 'resume' || s === 'resume-error') { await button(p, 'Resume').click(); if (s === 'resume-error') { await p.getByRole('dialog').getByRole('button', { name: 'Resume', exact: true }).click(); await p.getByRole('alert').waitFor(); } }
  if (s === 'add-host' || s === 'host-error') { await p.getByRole('button', { name: /Add host/ }).first().click(); if (s === 'host-error') { await p.getByLabel('SSH destination').fill('synthetic.invalid'); await p.getByRole('dialog').getByRole('button', { name: 'Add host', exact: true }).click(); await p.getByRole('alert').waitFor(); } }
  if (s === 'palette' || s === 'palette-empty') { await p.keyboard.press('Control+k'); if (s === 'palette-empty') await p.getByLabel('Find a Session').fill('synthetic-no-match'); }
  if (s === 'help') { await p.locator('body').click({ position: { x: 1000, y: 10 } }); await p.keyboard.press('?'); }
  if (['accounts', 'login', 'oauth'].includes(s)) {
    // A real app event opens the existing dialog; all account RPCs stay in the browser fixture.
    await p.evaluate(() => window.dispatchEvent(new CustomEvent('ampi:accounts', { detail: 'devbox' })));
    await p.locator('[data-accounts]').waitFor();
    if (s === 'login' || s === 'oauth') { await button(p, s === 'login' ? 'Add API key' : 'Sign in (subscription)').click(); await p.locator('.login-flow').waitFor(); }
    if (s === 'accounts' && !r.pending) await p.locator(r.reject ? '.accounts .err-box' : '.provider').waitFor();
  }
}
