#!/usr/bin/env node
// The only deploy path for pbe-employment-collector. Refuses unless: the tree is clean, HEAD is pushed, and the collector
// tests pass. Stamps CODE_COMMIT and CODE_FILES (sha256 of every bundled source file, the shared rules lib included) into
// the deployment, so every capture records exactly which code produced it.
//   node workers/pbe-employment-collector/scripts/deploy.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..'); const ROOT = join(W, '..', '..');
const git = (...a) => execFileSync('git', ['-c', 'safe.directory=*', ...a], { cwd: ROOT, encoding: 'utf8' }).trim();
const fail = (m) => { console.error(`REFUSED: ${m}`); process.exit(1); };
if (git('status', '--porcelain', '--', 'workers/pbe-employment-collector', 'scripts/research/employment/collector', 'test/employment-worker.test.js', 'test/employment-collector.test.js', 'test/employment-kalshi-auth.test.js')) fail('uncommitted collector changes');
const head = git('rev-parse', 'HEAD'); const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
git('fetch', '-q', 'origin', branch);
if (git('rev-parse', `origin/${branch}`) !== head) fail(`HEAD ${head.slice(0, 7)} is not pushed to origin/${branch}`);
execFileSync(process.execPath, ['--test', 'test/employment-worker.test.js', 'test/employment-collector.test.js', 'test/employment-kalshi-auth.test.js'], { cwd: ROOT, stdio: 'inherit' });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
const files = [...readdirSync(join(W, 'src')).map((f) => [f, sha(join(W, 'src', f))]), ['lib.mjs', sha(join(ROOT, 'scripts/research/employment/collector/lib.mjs'))]];
const CODE_FILES = files.map(([f, h]) => `${f}=${h}`).join(',');
const args = ['deploy', '--var', `CODE_COMMIT:${head}`, '--var', `CODE_FILES:${CODE_FILES}`, ...(process.argv.includes('--dry-run') ? ['--dry-run'] : [])];
console.log(`deploying ${head.slice(0, 7)} (${branch})\n${CODE_FILES}`);
execFileSync('wrangler', args, { cwd: W, stdio: 'inherit', shell: true });
