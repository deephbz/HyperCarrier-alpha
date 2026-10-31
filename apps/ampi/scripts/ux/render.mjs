// One projection of map.json. No independent screen/control inventory lives here.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const thumbnail = path => path.replace(/\.png$/, '.thumb.png');
export async function renderGrid(map, out, browser) {
  // Decode full-resolution captures one at a time. The overview uses small derivatives.
  // Keeping every original decoded in one page can exhaust a browser renderer.
  console.log('Rendering grid: thumbnails');
  const canvasPage = await browser.newPage();
  try {
    for (const n of map.nodes) {
      const source = (await readFile(join(out, n.screenshot))).toString('base64');
      const data = await canvasPage.evaluate(async ({ source, width }) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + source;
        await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 288;
        canvas.getContext('2d').drawImage(img, 0, 0, width, 288);
        return canvas.toDataURL('image/png').split(',')[1];
      }, { source, width: Math.round(n.viewport.width * .32) });
      await writeFile(join(out, thumbnail(n.screenshot)), Buffer.from(data, 'base64'));
    }
  } finally { await canvasPage.close(); }
  await writeFile(join(out, 'map.html'), render(map));
  const grid = await browser.newPage({ viewport: { width: 2700, height: 1200 }, deviceScaleFactor: 1 });
  grid.setDefaultTimeout(30_000);
  try {
    console.log('Rendering grid: loading HTML');
    await grid.goto(pathToFileURL(join(out, 'map.html')).href, { timeout: 30_000 });
    console.log('Rendering grid: decoding screenshots');
    await grid.locator('img').evaluateAll(images => Promise.race([
      Promise.all(images.map(i => i.decode())),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot decode timeout')), 30_000)),
    ]));
    console.log('Rendering grid: PNG');
    await grid.screenshot({ path: join(out, 'map.png'), fullPage: true, timeout: 30_000 });
  } finally { await grid.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/ux');
  const map = JSON.parse(await readFile(join(out, 'map.json'), 'utf8'));
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const browser = await chromium.launch(launchOptions());
  try { await renderGrid(map, out, browser); } finally { await browser.close(); }
}
export function render(map) {
  const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const columns = 6, scale = .32, width = 424, height = 350;
  const positions = new Map(map.nodes.map((n, i) => [n.id, { x: 18 + i % columns * width, y: 18 + Math.floor(i / columns) * height }]));
  const totalHeight = Math.ceil(map.nodes.length / columns) * height + 36;
  const callouts = n => n.elements.map(e => `<g><title>${esc(n.id + '/' + e.id + ' · ' + e.name)}</title><rect x="${e.bounds.x}" y="${e.bounds.y}" width="${e.bounds.width}" height="${e.bounds.height}" class="box"/><text x="${Math.min(n.viewport.width - 60, e.bounds.x + 1)}" y="${Math.max(22, e.bounds.y + 16)}" class="number">${esc(e.id.slice(1))}</text></g>`).join('');
  const cards = map.nodes.map(n => {
    const p = positions.get(n.id);
    return `<article class="cell" id="${n.id}" data-id="${n.id}" style="left:${p.x}px;top:${p.y}px;width:410px"><button class="open" data-open="${n.id}"><b>${n.id}</b> ${esc(n.title)}</button><small>${n.elements.length} controls · ${esc(n.evidence)}</small><div class="shot" style="height:288px;width:${n.viewport.width * scale}px"><img src="${thumbnail(n.screenshot)}" width="${n.viewport.width * scale}" height="288" alt="${esc(n.title)}"/><svg viewBox="0 0 ${n.viewport.width} 900">${callouts(n)}</svg></div></article>`;
  }).join('');
  const arrows = map.edges.filter(e => e.from !== e.to && e.kind !== 'disabled').map(e => {
    const a = positions.get(e.from), b = positions.get(e.to), n = map.nodes.find(n => n.id === e.from), el = n.elements.find(c => c.id === e.element);
    const x = a.x + (el.bounds.x + el.bounds.width / 2) * scale, y = a.y + 50 + el.bounds.y * scale;
    const tx = b.x + 15, ty = b.y + 8;
    return `<path class="${e.evidence.startsWith('browser-checked') ? 'primary' : 'secondary'}" data-from="${e.from}" data-to="${e.to}" d="M${x},${y} C${x + 70},${y - 20} ${tx - 70},${ty - 20} ${tx},${ty}" marker-end="url(#arrow)"><title>${esc(e.id + ' → ' + e.to + ' · ' + e.evidence)}</title></path>`;
  }).join('');
  const data = JSON.stringify(map).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>AmPi synthetic wireflow</title><style>
*{box-sizing:border-box}body{margin:0;background:#edf0f3;color:#17212b;font:14px system-ui}header{position:sticky;top:0;z-index:8;background:white;padding:12px 18px;border-bottom:1px solid #aab4bf;display:flex;gap:14px;align-items:center;flex-wrap:wrap}header p{margin:0;font-size:12px;width:100%}button,input,select{font:inherit}button{cursor:pointer}#viewport{overflow:auto;max-width:100vw}#space{position:relative;width:${columns * width + 36}px;height:${totalHeight}px;transform-origin:top left}.cell{position:absolute;background:#fff;border:1px solid #aab4bf;padding:4px;box-shadow:none;height:338px;overflow:hidden}.cell.selected{outline:3px solid #0879c7}.open{border:0;background:white;text-align:left;font-size:12px;height:26px;width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.cell small{font-size:10px;display:block;color:#475569;height:18px}.shot{position:relative;overflow:hidden;background:#fafafa}.shot img{display:block}.shot svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.box{fill:none;stroke:#0468aa;stroke-width:1}.number{fill:#064d7a;stroke:white;stroke-width:5;paint-order:stroke;stroke-linejoin:round;font:700 24px monospace}#arrows{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}#arrows path{stroke:#3879ac;stroke-width:1.2;fill:none;opacity:.14}#arrows .secondary{display:none}#arrows.all .secondary,#arrows .secondary.active{display:block}#arrows path.primary{opacity:.8;stroke-width:1.8}#arrows path.active{stroke:#b03900;stroke-width:2;opacity:.95}#arrows.hidden{display:none}dialog{width:96vw;max-width:1500px;height:94vh;border:1px solid #8b98a6;padding:14px}dialog::backdrop{background:#0008}dialog .shot{max-width:none}dialog .number{font-size:16px;stroke-width:3}dialog h2{font-size:18px;margin:0}dialog .top{display:flex;justify-content:space-between;position:sticky;top:0;background:white;z-index:2}table{border-collapse:collapse;width:100%;font-size:12px}td,th{padding:5px;border-bottom:1px solid #ddd;text-align:left}#detail-shot{overflow:auto}.warning{color:#92330b}code{font-family:ui-monospace,monospace}
</style><header><b>AmPi · synthetic wireflow</b><label>Zoom <input id="zoom" type="range" min="20" max="180" value="100" aria-label="Grid zoom"></label><label>Find <input id="find" placeholder="S04.c, Models, Team…" aria-label="Find screen or control"></label><label>Arrows <select id="arrows-mode"><option value="primary">Checked transitions</option><option value="all">All inferred links</option><option value="none">None</option></select></label><a href="map.json">Machine-readable source</a><span>${map.nodes.length} states · ${map.edges.length} edges</span><p>Blue numbers identify controls within each state. Click a title for full-size inspection and element → destination records. Default arrows show browser-checked setup transitions. Other destinations remain in the table. Select a state to reveal its inferred links. Self-loops stay in the table.</p><p class="warning">Synthetic evidence only. Inferred edges require verification. Frozen node views use browser fixtures. Source ${esc(map.sourceRevision.slice(0, 12))} · ${esc(map.capturedAt)}</p></header><div id="viewport"><div id="space">${cards}<svg id="arrows" viewBox="0 0 ${columns * width + 36} ${totalHeight}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#3879ac"/></marker></defs>${arrows}</svg></div></div><dialog id="detail"><div class="top"><h2></h2><button id="close">Close</button></div><p id="meta"></p><div id="detail-shot"></div><h3>Controls and destinations</h3><table><thead><tr><th>Reference</th><th>Control</th><th>Destination</th><th>Evidence</th></tr></thead><tbody></tbody></table></dialog><script>
const map=${data}; const $=s=>document.querySelector(s); const detail=$('#detail');
function safe(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
function select(id){document.querySelectorAll('.cell').forEach(n=>n.classList.toggle('selected',n.dataset.id===id));document.querySelectorAll('#arrows path').forEach(n=>n.classList.toggle('active',n.dataset.from===id||n.dataset.to===id))}
function open(id){const n=map.nodes.find(n=>n.id===id);select(id);detail.querySelector('h2').textContent=n.id+' · '+n.title;$('#meta').textContent=n.route+' · '+n.evidence+' · '+n.viewport.width+'×900 · '+n.theme;const source=document.getElementById(id).querySelector('.shot');$('#detail-shot').innerHTML=source.outerHTML;const shot=$('#detail-shot .shot');shot.style.width=n.viewport.width+'px';shot.style.height='900px';const img=shot.querySelector('img');img.src=n.screenshot;img.width=n.viewport.width;img.height=900;detail.querySelector('tbody').innerHTML=n.elements.map(e=>{const edge=map.edges.find(t=>t.from===id&&t.element===e.id);return '<tr><td><code>'+safe(id+'/'+e.id)+'</code></td><td>'+safe(e.name)+(e.enabled?'':' (disabled)')+'</td><td>'+safe(edge.to)+'</td><td>'+safe(edge.evidence)+'</td></tr>'}).join('');detail.showModal()}
document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>open(b.dataset.open));$('#close').onclick=()=>detail.close();$('#zoom').oninput=e=>{$('#space').style.zoom=e.target.value/100};$('#arrows-mode').onchange=e=>{$('#arrows').classList.toggle('all',e.target.value==='all');$('#arrows').classList.toggle('hidden',e.target.value==='none')};$('#find').oninput=e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.cell').forEach(c=>{const n=map.nodes.find(n=>n.id===c.dataset.id);c.style.opacity=!q||JSON.stringify(n).toLowerCase().includes(q)?'1':'.2'})};
</script></html>`;
}
