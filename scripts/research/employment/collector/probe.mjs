#!/usr/bin/env node
// Unattended-identity PROBE for the Employment collector (test only; writes nothing to the evidence repo).
// Run by separate test tasks under candidate identities (S4U, LOCAL SERVICE). Each run records who it ran as, whether
// any user was signed in, a public-source fetch, an SSH authentication to GitHub with a probe-only deploy key, and a
// real push to LHBUSA/pbe-collector-probe confirmed by reading the remote ref back.
//   node probe.mjs <label> <clone-dir> <deploy-key> <known-hosts>
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [label, dir, key, knownHosts] = process.argv.slice(2);
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const run = (bin, args, opts = {}) => { const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...opts }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 400), error: r.error ? String(r.error.message) : undefined }; };
const sshCmd = `"${SSH.replace(/\\/g, '/')}" -i "${key.replace(/\\/g, '/')}" -o IdentitiesOnly=yes -o UserKnownHostsFile="${knownHosts.replace(/\\/g, '/')}" -o StrictHostKeyChecking=yes -o BatchMode=yes`;
const git = (...a) => run(GIT, ['-c', 'safe.directory=*', '-c', 'credential.helper=', '-c', `core.sshCommand=${sshCmd}`, ...a], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

const rec = { label, at_utc: new Date().toISOString(), pid: process.pid, env_username: process.env.USERNAME || null, env_userprofile: process.env.USERPROFILE || null, session_name: process.env.SESSIONNAME || null };
rec.whoami = run('C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']).out;
const groups = spawnSync('C:\\Windows\\System32\\whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout || '';
rec.logon_type_groups = groups.split('\n').map((l) => l.split('","')[0].replace(/"/g, '').trim()).filter((g) => /\\(INTERACTIVE|BATCH|SERVICE|NETWORK|CONSOLE LOGON|LOCAL)$|^LOCAL$/.test(g));
// Windows Home has no quser: the console user from WMI, plus whether any desktop shell (explorer.exe) is running
rec.console_user = run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).UserName']).out || 'none';
rec.explorer_processes = (run('C:\\Windows\\System32\\tasklist.exe', ['/FI', 'IMAGENAME eq explorer.exe', '/FO', 'CSV', '/NH']).out.match(/explorer\.exe/gi) || []).length;
rec.signed_in = rec.console_user !== 'none' || rec.explorer_processes > 0;
try {
  const t0 = Date.now();
  const r = await fetch('https://api.elections.kalshi.com/trade-api/v2/series/KXU3', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; research-bot)' }, signal: AbortSignal.timeout(20000) });
  const b = Buffer.from(await r.arrayBuffer());
  rec.public_fetch = { url: r.url, status: r.status, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex'), ms: Date.now() - t0 };
} catch (e) { rec.public_fetch = { error: String(e?.cause?.code || e.message) }; }
const s = run(SSH, ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-T', 'git@github.com']);
rec.ssh_auth = { exit: s.code, authenticated: /successfully authenticated/.test(s.out), out: s.out.split('\n').at(-1) };
const branch = `probe/${label}`;
const line = JSON.stringify({ ...rec, note: 'probe record (before push)' });
appendFileSync(join(dir, `probe-${label}.jsonl`), line + '\n');
const steps = { add: git('add', '-A').code, commit: git('commit', '-q', '-m', `probe ${label} ${rec.at_utc}`).code };
const push = git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
const head = git('rev-parse', 'HEAD').out;
const remote = git('ls-remote', 'origin', `refs/heads/${branch}`).out.split(/\s+/)[0] || null;
rec.git = { ...steps, push_exit: push.code, push_out: push.out.slice(0, 200), local_head: head, remote_head: remote, remote_confirmed: !!remote && remote === head };
rec.pass = rec.public_fetch?.status === 200 && rec.ssh_auth.authenticated && rec.git.remote_confirmed;
appendFileSync(join(dir, '..', `probe-results-${label}.jsonl`), JSON.stringify(rec) + '\n'); // outside the clone, kept even if git fails
writeFileSync(join(dir, '..', `probe-last-${label}.json`), JSON.stringify(rec, null, 1));
process.exitCode = rec.pass ? 0 : 1;
