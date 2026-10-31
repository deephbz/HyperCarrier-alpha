// Pixel diff of two whole screenshots in a Chromium canvas; no image dependency.
// A pixel differs when any channel differs. Pixels outside the shared area of two sizes all count as changed.
// `boxes` are the target boxes of both sides; `outside` counts the changed pixels in none of them.

/** → { changed, outside, total, width, height, png }. The PNG shows the after image faded to grey, changes in red. */
export async function diffPngs(page, before, after, boxes = []) {
  const result = await page.evaluate(async ({ a, b, boxes }) => {
    const load = async data => { const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode(); return img; };
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const width = Math.max(ia.width, ib.width), height = Math.max(ia.height, ib.height);
    const pixels = img => { const c = document.createElement('canvas'); c.width = width; c.height = height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return { data: g.getImageData(0, 0, width, height).data, w: img.width, h: img.height }; };
    const pa = pixels(ia), pb = pixels(ib);
    const out = document.createElement('canvas'); out.width = width; out.height = height;
    const g = out.getContext('2d'); const view = g.createImageData(width, height); const o = view.data;
    const inBox = (x, y) => boxes.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
    let changed = 0, outside = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const shared = x < pa.w && y < pa.h && x < pb.w && y < pb.h;
      const same = shared && pa.data[i] === pb.data[i] && pa.data[i + 1] === pb.data[i + 1] && pa.data[i + 2] === pb.data[i + 2] && pa.data[i + 3] === pb.data[i + 3];
      if (same) {
        const grey = 255 - (255 - (pb.data[i] * .3 + pb.data[i + 1] * .59 + pb.data[i + 2] * .11)) * .25;
        o[i] = o[i + 1] = o[i + 2] = grey; o[i + 3] = 255;
      } else {
        changed++; if (!inBox(x, y)) outside++;
        o[i] = 230; o[i + 1] = 0; o[i + 2] = 40; o[i + 3] = 255;
      }
    }
    g.putImageData(view, 0, 0);
    return { changed, outside, total: width * height, width, height, png: out.toDataURL('image/png').split(',')[1] };
  }, { a: before.toString('base64'), b: after.toString('base64'), boxes });
  return { ...result, png: Buffer.from(result.png, 'base64') };
}
