// GitHub mirror of the evidence repo through the authenticated REST API (no git, no SSH). One commit per tick: a blob per
// new file (its git object id is checked against the bytes we hold), the monthly ledger appended, a tree on top of the
// current head, a commit, then a NON-forced ref update (branch protection rejects anything else). A fast-forward race is
// retried once from the new head. The remote must keep containing the last head we pushed (rewrite detection).
import { b64, dec, gitBlobSha } from './util.js';

export class GitHubMirror {
  constructor({ token, repo, branch = 'main', fetchImpl = fetch }) { this.token = token; this.repo = repo; this.branch = branch; this.fetch = fetchImpl; this.calls = 0; }
  async api(method, path, body, accept = 'application/vnd.github+json') {
    this.calls += 1;
    const r = await this.fetch(`https://api.github.com/repos/${this.repo}${path}`, { method, headers: { authorization: `Bearer ${this.token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'pbe-employment-collector', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (accept.includes('raw')) return r.status === 404 ? null : r.ok ? new Uint8Array(await r.arrayBuffer()) : Promise.reject(new Error(`github ${method} ${path} ${r.status}`));
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(`github ${method} ${path} ${r.status} ${JSON.stringify(j?.message ?? '').slice(0, 160)}`); e.status = r.status; throw e; }
    return j;
  }
  async head() { return (await this.api('GET', `/git/ref/heads/${this.branch}`)).object.sha; }
  // files: [{ path, bytes }]; ledger: { path, text } appended to that file; returns the new commit sha
  async commit(files, ledger, message) {
    for (let attempt = 1; ; attempt++) {
      const parent = await this.head();
      const baseTree = (await this.api('GET', `/git/commits/${parent}`)).tree.sha;
      const tree = [];
      for (const f of files) {
        const blob = await this.api('POST', '/git/blobs', { content: b64(f.bytes), encoding: 'base64' });
        const expect = await gitBlobSha(f.bytes);
        if (blob.sha !== expect) throw new Error(`MIRROR_BLOB_MISMATCH ${f.path} ${blob.sha} != ${expect}`);
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      if (ledger?.text) {
        const prev = await this.api('GET', `/contents/${ledger.path}?ref=${parent}`, null, 'application/vnd.github.raw');
        const text = (prev ? dec.decode(prev) : '') + ledger.text;
        const blob = await this.api('POST', '/git/blobs', { content: b64(text), encoding: 'base64' });
        tree.push({ path: ledger.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      if (!tree.length) return null;
      const t = await this.api('POST', '/git/trees', { base_tree: baseTree, tree });
      const c = await this.api('POST', '/git/commits', { message, tree: t.sha, parents: [parent] });
      try { await this.api('PATCH', `/git/refs/heads/${this.branch}`, { sha: c.sha, force: false }); return c.sha; } catch (e) { if (attempt >= 2 || e.status !== 422) throw e; }
    }
  }
  // OK when the remote branch still contains `sha`; REWRITTEN when it does not (reset, force-push or deleted history)
  async remoteHistory(sha) {
    if (!sha) return { status: 'NO_PUSHED_HEADS' };
    try {
      const head = await this.head();
      if (head === sha) return { status: 'OK', last_pushed: sha, remote_head: head };
      const c = await this.api('GET', `/compare/${sha}...${head}`);
      return { status: c.status === 'ahead' || c.status === 'identical' ? 'OK' : 'REWRITTEN', last_pushed: sha, remote_head: head, compare: c.status };
    } catch (e) { return { status: e.status === 404 ? 'REWRITTEN' : 'CHECK_FAILED', last_pushed: sha, error: String(e.message).slice(0, 160) }; }
  }
  async createIssue(title, body) { return (await this.api('POST', '/issues', { title, body })).html_url; }
  async treeFiles(ref) { return (await this.api('GET', `/git/trees/${ref}?recursive=1`)).tree.filter((x) => x.type === 'blob'); }
  async blob(sha) { const j = await this.api('GET', `/git/blobs/${sha}`); return Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)); }
}
