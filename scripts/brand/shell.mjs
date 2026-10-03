// Emits the network shell (one implementation: workers/pbe-predictions/src/network.js) for the static pages.
//   node scripts/brand/shell.mjs            -> JSON { header: { <current>: html }, footer: html } on stdout
//   node scripts/brand/shell.mjs --index    -> rewrites index.html between the network markers in place
import { readFileSync, writeFileSync } from 'node:fs';
import { siteHeader, siteFooter } from '../../workers/pbe-predictions/src/network.js';

if (process.argv.includes('--index')) {
  let html = readFileSync('index.html', 'utf8');
  const swap = (name, body) => {
    const re = new RegExp(`<!-- network:${name} -->[\\s\\S]*?<!-- /network:${name} -->`);
    if (!re.test(html)) throw new Error(`index.html is missing <!-- network:${name} --> markers`);
    html = html.replace(re, `<!-- network:${name} -->\n${body}\n<!-- /network:${name} -->`);
  };
  swap('header', siteHeader('desk'));
  swap('footer', siteFooter());
  writeFileSync('index.html', html);
  console.log('index.html shell updated');
} else {
  process.stdout.write(JSON.stringify({ header: { models: siteHeader('models'), methodology: siteHeader('methodology'), none: siteHeader(null) }, footer: siteFooter() }));
}
