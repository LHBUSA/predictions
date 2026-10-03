// The vendored propsports-markets files must stay byte-identical to the pinned canonical copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dir = new URL('../src/vendor/propsports-markets/', import.meta.url);
const manifest = readFileSync(new URL('VENDOR.md', dir), 'utf8');
const pinned = Object.fromEntries([...manifest.matchAll(/^\| ([a-z-]+\.js) \| ([0-9a-f]{64}) \|$/gm)].map((m) => [m[1], m[2]]));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('vendored files match the pinned manifest', () => {
  assert.deepEqual(Object.keys(pinned).sort(), ['api-order.js', 'core.js', 'history.js', 'match.js']);
  for (const [file, hash] of Object.entries(pinned)) assert.equal(sha(readFileSync(new URL(file, dir))), hash, file);
});

const CANONICAL = 'D:/Workers/propbetedge-workers/workers/propsports-markets/src/';
test('canonical comparison (informational when the canonical checkout exists)', { skip: !existsSync(CANONICAL) }, (t) => {
  for (const file of Object.keys(pinned)) {
    const same = sha(readFileSync(CANONICAL + file)) === pinned[file];
    if (!same) t.diagnostic(`${file} drifted from canonical — re-vendor and re-run the suite`);
  }
});
