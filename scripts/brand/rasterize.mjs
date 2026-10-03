// Rasterizes the brand kit (run after brand-kit.py): favicons, touch/app/maskable icons, logo PNGs.
// Uses @resvg/resvg-js (devDependency); fonts are outlined in the SVGs so no system fonts are involved.
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const png = (svgPath, out, width) => {
  const r = new Resvg(readFileSync(svgPath, 'utf8'), { fitTo: { mode: 'width', value: width } }).render();
  writeFileSync(out, r.asPng());
  console.log(out, `${r.width}x${r.height}`, readFileSync(out).length, 'B');
};
png('brand/predictions-mark-small.svg', 'favicon-16x16.png', 16);
png('brand/predictions-mark-small.svg', 'favicon-32x32.png', 32);
png('brand/predictions-mark-touch.svg', 'apple-touch-icon.png', 180);
png('brand/predictions-mark.svg', 'brand/icon-192.png', 192);
png('brand/predictions-mark.svg', 'brand/icon-512.png', 512);
png('brand/predictions-mark-maskable.svg', 'brand/icon-maskable-512.png', 512);
png('brand/predictions-mark.svg', 'brand/predictions-logo-512.png', 512);
png('brand/predictions-wordmark.svg', 'brand/predictions-wordmark.png', 900);
png('brand/predictions-wordmark-dark.svg', 'brand/predictions-wordmark-dark.png', 900);
