#!/usr/bin/env node
// CUTOVER TOOL (run only after the owner approves the authoritative cutover, with the Windows tasks already disabled).
// Uploads the historical Windows-collected evidence, byte-for-byte, from the git-verified local clone into the R2 root
// through PUT /admin/historical (sha256 checked by the Worker before writing, then by R2; write-once). Read-only towards
// git. Monthly ledger files go to ledger-imported/<head>/ because the live R2 ledger is the hash-chained ledger-ticks/.
//   node upload-historical.mjs <evidence-clone> <worker-url> <admin-token-file> [--dry-run]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [clone, worker, tokenFile] = process.argv.slice(2); const dry = process.argv.includes('--dry-run');
const git = (...a) => execFileSync('git', ['-c', 'safe.directory=*', ...a], { cwd: clone, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const fail = (m) => { console.error(`REFUSED: ${m}`); process.exit(1); };
if (git('status', '--porcelain', '--untracked-files=no')) fail('evidence clone has uncommitted changes');
git('fsck', '--strict', '--no-dangling');
const head = git('rev-parse', 'HEAD');
const origin = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
if (origin && origin !== head) fail(`local HEAD ${head} != GitHub main ${origin}`);
const token = readFileSync(tokenFile, 'utf8').trim();
const out = { head, uploaded: 0, existed: 0, files: [] };
for (const line of git('ls-files', '-s').split('\n')) {
  const [, blob, , path] = line.match(/^(\d+) ([0-9a-f]{40}) (\d)\t(.+)$/);
  const bytes = readFileSync(join(clone, path));
  const gitId = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  if (gitId !== blob) fail(`${path}: working file differs from the committed blob`);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const target = /^ledger\/[^/]+\.jsonl$/.test(path) ? `ledger-imported/${head}/${path}` : path;
  if (dry) { out.files.push({ path: target, sha256: sha }); continue; }
  const r = await fetch(`${worker}/admin/historical?path=${encodeURIComponent(target)}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-content-sha256': sha }, body: bytes });
  const j = await r.json();
  if (!r.ok || j.sha256 !== sha) fail(`${target}: ${r.status} ${JSON.stringify(j)}`);
  out[j.existed ? 'existed' : 'uploaded'] += 1; out.files.push({ path: target, sha256: sha });
}
console.log(JSON.stringify({ ...out, count: out.files.length, files: dry ? out.files : undefined }, null, 1));
