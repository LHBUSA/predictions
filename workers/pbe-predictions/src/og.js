// Social-card rasterizer: SVG (og-render.js) -> PNG with resvg (WebAssembly) inside this Worker.
// Fonts (Inter, SIL OFL 1.1) and the card background are bundled; no external renderer or paid product.
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import inter500 from '../assets/inter-500.ttf';
import inter700 from '../assets/inter-700.ttf';
import inter800 from '../assets/inter-800.ttf';
import cardBg from '../assets/card-bg.jpg';

let ready = null;
let bgUri = null;
const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

export async function renderPng(svg, { background = null } = {}) {
  ready ||= initWasm(resvgWasm);
  await ready;
  bgUri ||= `data:image/jpeg;base64,${b64(cardBg)}`;
  const uri = background ? `data:image/jpeg;base64,${b64(background)}` : bgUri;
  const withBg = svg.replace('<rect width="1200" height="630" fill="#020a16"/>', `<rect width="1200" height="630" fill="#020a16"/><image href="${uri}" x="0" y="0" width="1200" height="630"/>`);
  const r = new Resvg(withBg, { font: { fontBuffers: [new Uint8Array(inter500), new Uint8Array(inter700), new Uint8Array(inter800)], loadSystemFonts: false, defaultFontFamily: 'Inter' } });
  const png = r.render().asPng();
  r.free?.();
  return png;
}
