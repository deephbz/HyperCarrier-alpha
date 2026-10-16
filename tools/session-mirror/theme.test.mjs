// Theme checks protect readability and pre-paint fallback without an upstream checkout.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./ide.html', import.meta.url), 'utf8');
const data = JSON.parse(readFileSync(new URL('./themes.json', import.meta.url), 'utf8'));
const boot = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
function start(payload, saved, storageDenied = false) {
  const root = { style: { setProperty(k, v) { this[k] = v; } }, dataset: {} };
  const context = vm.createContext({ document: { documentElement: root,
    getElementById: () => ({ textContent: payload }) },
    localStorage: { getItem() { if (storageDenied) throw Error('denied'); return saved; } } });
  vm.runInContext(boot, context);
  return { root, palettes: vm.runInContext('themeData.palettes', context) };
}
const channels = (s) => s.slice(1).match(/../g).map((v) => parseInt(v, 16));
const mix = (a, b, percent) => a.map((v, i) => Math.round((v * percent + b[i] * (100 - percent)) / 100));
function ratio(a, b) {
  const lum = (v) => v.map((n) => n / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
    .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  return (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
}
function checkPalette(p) {
  const c = Object.fromEntries(Object.entries(p.colors).map(([k, v]) => [k, channels(v)]));
  const surfaces = { bg:c.bg, side:c['bg-soft'], panel:mix(c['bg-soft'], c.bg, 50),
    hover:mix(c.fg, c.bg, 6), user:mix(c.blue, c.bg, 10),
    add:mix(c.green, c.bg, 8), del:mix(c.red, c.bg, 8), hit:mix(c.yellow, c.bg, 15) };
  const inks = { fg:c.fg, ...Object.fromEntries(Object.entries(p.mix).map(([k, v]) => [k, mix(c[k], c.fg, parseInt(v))])) };
  for (const [ink, value] of Object.entries(inks)) for (const [surface, bg] of Object.entries(surfaces)) {
    assert.ok(ratio(value, bg) >= 4.5, `${p.key} ${ink}/${surface}: ${ratio(value, bg)}`);
  }
  // Current hit and text selection invert these pairs. State edges use AA ink.
  assert.ok(ratio(inks.yellow, c.bg) >= 4.5, `${p.key} current search hit`);
  assert.ok(ratio(c.fg, c.bg) >= 4.5, `${p.key} selection and buttons`);
}
test('all IDE-owned palettes retain AA ink on every tinted surface', () => {
  assert.equal(data.palettes.length, 14);
  data.palettes.forEach(checkPalette);
});
test('saved light palette applies synchronously before body paint', () => {
  const { root } = start(JSON.stringify(data), 'modus');
  assert.equal(root.dataset.theme, 'modus');
  assert.equal(root.style.colorScheme, 'light');
  assert.equal(root.style['--cs-bg'], data.palettes.find((p) => p.key === 'modus').colors.bg);
});
test('missing, invalid and malformed palette data use a readable built-in default', () => {
  for (const payload of ['null', '{broken', '{}', '{"schemaVersion":1,"palettes":[]}',
    JSON.stringify({ ...data, palettes: [{ ...data.palettes[0], mix: {} }] })]) {
    const { root, palettes } = start(payload, 'modus');
    assert.equal(root.dataset.theme, 'modus-dark');
    assert.equal(palettes.length, 1);
    checkPalette(palettes[0]);
  }
});
test('unknown saved key and denied storage do not stop theme setup', () => {
  assert.equal(start(JSON.stringify(data), 'removed-theme').root.dataset.theme, 'modus-dark');
  assert.equal(start(JSON.stringify(data), 'modus', true).root.dataset.theme, 'modus-dark');
});
test('renderer keeps concrete colours in its single fallback block', () => {
  const withoutFallback = html.replace(/const fallbackPalette = \{[\s\S]*?\n\};/, '');
  assert.doesNotMatch(withoutFallback, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(withoutFallback, /\b(?:rgb|hsl)a?\(/i);
});
