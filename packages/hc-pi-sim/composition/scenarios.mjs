// The HC-owned deployed subset, in operator load order. No personal settings are read.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SimWorld, magpieProfile, normalizeTrace, checkCacheHistory, assertEntriesPreserved } from '../src/index.mjs';

export const extensionPaths = [
  '../../systemp-prompt-audit/index.ts', '../../hc-rarebit/src/extension.mjs',
  '../../pi-cache-goblin/src/extension.mjs', '../../hc-auto-compact/src/extension.mjs',
  '../../hc-hud/src/extension.mjs', '../../pi-openai-blackmagic-compact/src/extension.mjs',
  '../../../apps/trace-viewer/pi/view-trace.mjs',
].map(path => fileURLToPath(new URL(path, import.meta.url)));
export const profiles = [
  ...['anthropic', 'openai-responses', 'openai-completions', 'google', 'vertex', 'bedrock'].map(family => ({ name: family, options: { family } })),
  { name: 'magpie', options: magpieProfile() },
];

// A headless UI boundary invokes real component.render(). It does not emulate terminal input,
// cursor/focus behavior, ANSI output or visual acceptance. Component algorithms stay real.
function renderBoundary() {
  const frames = [], components = new Set();
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text, inverse: text => text };
  const render = () => { for (const component of components) frames.push(component.render(100)); };
  const tui = { terminal: { rows: 20, columns: 100 }, requestRender: render, showOverlay() {} };
  const uiContext = { theme,
    setFooter(factory) {
      if (!factory) return;
      const footerData = { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
      const footer = factory(tui, theme, footerData);
      frames.push(footer.render(100));
    },
    custom(factory, options = {}) {
      let component;
      return new Promise(resolve => {
        const done = value => { components.delete(component); resolve(value); };
        component = factory(tui, theme, {}, done);
        components.add(component); render();
        options.onHandle?.({ isFocused: () => !options.overlayOptions?.nonCapturing });
      });
    },
  };
  return { uiContext, frames, render };
}
async function until(world, predicate) {
  await world.run(async () => {
    const end = Date.now() + 20000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('composition compaction did not settle');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
}
export async function composition(profile, { seed = 37, mutant } = {}) {
  const ui = renderBoundary();
  const world = await SimWorld.create({ ...profile.options, seed, extensionPaths, mode: 'tui', uiContext: ui.uiContext,
    extensionFactories: mutant ? [pi => {
      let changed = false;
      pi.registerCommand('composition-mutate', { description: 'Test-only prefix mutation', handler: async () => {
        changed = true;
        if (mutant === 'tool-inventory') pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'auto_compact_ready'));
      } });
      if (mutant === 'system-prefix') pi.on('before_agent_start', event => changed ? { systemPrompt: event.systemPrompt + '\nSynthetic changed system prefix.' } : undefined);
    }] : [],
    settings: { compaction: { enabled: false, keepRecentTokens: 32 } },
    replies: [{ text: 'Synthetic progress. '.repeat(120), delayMs: 30000 }, { text: 'Second answer' },
      { toolCalls: [{ name: 'compaction_plan', arguments: { summary: 'Composed working state', keep: [] } }] }, { text: 'Resumed' }],
  });
  try {
    writeFileSync(join(world.agentDir, 'settings.json'), JSON.stringify({ auto_compact: { method: 'summary', preservation: 'none' }, rarebit: { auto_title: false } }));
    await world.run(() => world.session.extensionRunner.emit({ type: 'session_start' }));
    await world.prompt('First composition goal');
    await world.prompt('/rarebit view all');
    if (mutant) await world.prompt('/composition-mutate');
    await world.prompt('Second composition goal');
    const before = structuredClone(world.sessionManager.getEntries());
    await world.prompt('/auto-compact run');
    await until(world, () => world.requests.length === 4 && !world.session.isStreaming);
    ui.render();
    assertEntriesPreserved(before, world.sessionManager.getEntries());
    await world.prompt('/rarebit view off');
    world.assertHealthy();
    const result = world.report();
    // Explicit compaction changes context identity. Gate the ordinary+handoff prefix separately
    // from the new post-compaction epoch; retain the unsplit assessment as diagnostic evidence.
    return { ...result, trace: normalizeTrace(result.trace, world.root), frames: ui.frames,
      epochs: [checkCacheHistory(world.requests.slice(0, 3)), checkCacheHistory(world.requests.slice(3))] };
  } catch (error) {
    error.trace = normalizeTrace(world.report().trace, world.root); throw error;
  } finally { await world.close(); }
}
