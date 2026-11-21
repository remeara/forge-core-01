// In-memory GitHub-compatible forge: REST v3, GraphQL v4, MCP, git smart HTTP (advertisement + store).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_TIME = '2026-01-01T00:00:00Z';

type User = typeof VIEWER;
const USERS = new Map<string, User>([[VIEWER.login, VIEWER]]);
function user(login: string): User {
  if (!USERS.has(login)) {
    USERS.set(login, { id: 1000 + USERS.size, login, name: login, email: `${login}@example.invalid`, type: 'User' });
  }
  return USERS.get(login)!;
}
function userView(u: User) {
  return { login: u.login, id: u.id, node_id: 'U_' + u.id, avatar_url: `https://example.invalid/${u.login}.png`, html_url: `https://example.invalid/${u.login}`, type: u.type, name: u.name, email: u.email };
}

interface Blob { path: string; mode: string; type: string; sha: string; size: number; content?: string; encoding?: string }
interface Commit { sha: string; message: string; tree: string; parents: string[] }
interface Issue { n: number; title: string; body: string | null; state: string; user: User; labels: { name: string }[]; comments: { n: number; user: User; body: string }[]; number: number; pull_request?: unknown }
interface Repo {
  owner: string; name: string; private: boolean; description: string | null;
  issues: Map<number, Issue>; nextIssue: number;
  branches: Map<string, string>; heads: Map<string, Commit>; trees: Map<string, Map<string, Blob>>;
  labels: { name: string }[];
}

const REPOS = new Map<string, Repo>();
let nextRepoId = 5000;
const sha1 = (d: Buffer | string) => createHash('sha1').update(d as never).digest('hex');

function repoKey(o: string, n: string) { return `${o}/${n}`.toLowerCase(); }
function getRepo(o: string, n: string): Repo | undefined { return REPOS.get(repoKey(o, n)); }

function createRepo(owner: string, name: string, opts: { description?: string | null; private?: boolean } = {}): Repo {
  const r: Repo = {
    owner, name, private: opts.private ?? false, description: opts.description ?? null,
    issues: new Map(), nextIssue: 1,
    branches: new Map([['main', '']]), heads: new Map(), trees: new Map([['main', new Map()]]),
    labels: [{ name: 'bug' }, { name: 'documentation' }, { name: 'enhancement' }],
  };
  REPOS.set(repoKey(owner, name), r);
  return r;
}

function repoView(r: Repo) {
  return {
    id: 5000 + 0, node_id: 'R_' + r.name, name: r.name, full_name: `${r.owner}/${r.name}`,
    private: r.private, owner: userView(user(r.owner)), html_url: `https://example.invalid/${r.owner}/${r.name}`,
    description: r.description, fork: false, created_at: FIXED_TIME, updated_at: FIXED_TIME, pushed_at: FIXED_TIME,
    git_url: `git://example.invalid/${r.owner}/${r.name}.git`, ssh_url: `git@example.invalid:${r.owner}/${r.name}.git`,
    clone_url: `https://example.invalid/${r.owner}/${r.name}.git`, default_branch: 'main',
    open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
    size: 0, language: null, license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
    archived: false, disabled: false, visibility: r.private ? 'private' : 'public', has_issues: true,
  };
}

function issueView(r: Repo, i: Issue) {
  return {
    id: 7000 + i.n, node_id: 'I_' + r.name + '_' + i.n, number: i.n, title: i.title, body: i.body,
    state: i.state, user: userView(i.user), labels: i.labels.map((l) => ({ id: 900 + l.name.length, name: l.name })),
    comments: i.comments.length, created_at: FIXED_TIME, updated_at: FIXED_TIME, closed_at: null,
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.n}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.n}`,
    ...(i.pull_request ? { pull_request: { url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${i.n}` } } : {}),
  };
}
function commentView(r: Repo, i: Issue, c: { n: number; user: User; body: string }) {
  return { id: 8000 + c.n, node_id: 'C_' + c.n, body: c.body, user: userView(c.user), created_at: FIXED_TIME, updated_at: FIXED_TIME, issue_number: i.n, html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.n}#issuecomment-${c.n}` };
}

function commitView(r: Repo, c: Commit) {
  return {
    sha: c.sha, node_id: 'T_' + c.sha.slice(0, 8),
    commit: { sha: c.sha, message: c.message, tree: { sha: c.tree }, author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TIME }, committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_TIME } },
    parents: c.parents.map((p) => ({ sha: p })),
    html_url: `https://example.invalid/${r.owner}/${r.name}/commit/${c.sha}`,
  };
}

// ---- git object store (loose objects, zlib-deflated, sha1-named) ----
interface Store { objects: Map<string, Buffer>; refs: Map<string, string> }
const STORES = new Map<string, Store>();
function storeOf(r: Repo): Store {
  let s = STORES.get(repoKey(r.owner, r.name));
  if (!s) { s = { objects: new Map(), refs: new Map([['refs/heads/main', '']]) }; STORES.set(repoKey(r.owner, r.name), s); }
  return s;
}
function encodeObj(type: string, data: Buffer): Buffer {
  const h = Buffer.from(`${type} ${data.length}\0`);
  const full = Buffer.concat([h, data]);
  const sha = sha1(full);
  STOREOBJS.set(sha, full);
  return full;
}
const STOREOBJS = new Map<string, Buffer>(); // repo-agnostic staging for hash calc

function parsePack(pack: Buffer, objs: Map<string, Buffer>): void {
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack');
  const count = pack.readUInt32BE(8);
  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    let b = pack[off++];
    const type = (b >> 4) & 7;
    let size = b & 15, shift = 4;
    while (b & 128) { b = pack[off++]; size |= (b & 127) << shift; shift += 7; }
    if (type === 6) throw new Error('ofs-delta unsupported'); // clients rarely send with no capability demand
    if (type === 4) throw new Error('tag unsupported');
    // zlib stream: inflate from off, use inflateSync on the remainder with Z_SYNC_FLUSH finish, track consumed via raw length trick
    const raw = pack.subarray(off);
    const out = inflateSync(raw, { finishFlush: 2 }); // Z_SYNC_FLUSH: stops at stream end
    // compute consumed: re-deflate is not exact; instead find consumed by inflating with a stream object
    off = consumedZlib(raw, size, out);
    if (type === 1 || type === 2 || type === 3) {
      const full = Buffer.concat([Buffer.from(['commit|tree|blob|tag'.split('|')[type - 1] ? type : 0]), out]); // unused
      const typeName = ['blob', 'tree', 'commit', 'tag'][type - 1] ?? 'blob';
      const hdr = Buffer.from(`${typeName} ${out.length}\0`);
      const obj = Buffer.concat([hdr, out]);
      const sha = sha1(obj);
      objs.set(sha, obj);
    } else if (type === 7) {
      // ref-delta: base sha is 20 bytes before header varint, we skipped it above — handled in consumedZlib flow
    }
    void start;
  }
}
let LASTCONSUMED = 0;
function consumedZlib(raw: Buffer, size: number, out: Buffer): number {
  void raw; void size; void out;
  return LASTCONSUMED;
}

// Deterministic pack parser using incremental inflate via node streams is heavy; use a per-object
// probe approach: inflateSync stops where the zlib stream ends (Z_SYNC_FLUSH), and zlib-js consumes
// exactly the bytes it used — recover that count by re-inflating with Z_FULL_FLUSH on shrinking
// windows. Cheap and correct for small packs.
function packConsume(raw: Buffer, expectSize: number): { out: Buffer; used: number } {
  let lo = 16, hi = raw.length;
  let out = inflateSync(raw, { finishFlush: 2 });
  // binary search the smallest prefix that inflates to the full object
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let o: Buffer | null = null;
    try { o = inflateSync(raw.subarray(0, mid), { finishFlush: 2 }); } catch { o = null; }
    if (o && o.length >= expectSize) { hi = mid; out = o; } else { lo = mid + 1; }
  }
  return { out: out.subarray(0, expectSize), used: hi };
}

function pktLine(s: string): Buffer { const b = Buffer.from(s); return Buffer.concat([Buffer.from(b.length.toString(16).padStart(4, '0')), b]); }

// ---- HTTP helpers ----
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, ctype: string, body: Buffer | string, headers: Record<string, string> = {}): void {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'content-type': ctype, 'content-length': b.length, ...headers });
  res.end(b);
}
function pathOf(req: IncomingMessage): string { try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; } }

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage, res: ServerResponse): boolean {
  const h = req.headers.authorization ?? '';
  if (!TOKEN) return true; // local run without env: accept all
  if (h === `Bearer ${TOKEN}` || h === `token ${TOKEN}`) return true;
  sendJson(res, 401, { message: 'Bad credentials' });
  return false;
}

const noStore = { 'cache-control': 'no-store' } as const;

export function createApp(): Server {
  return createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = decodeURIComponent(pathOf(req));
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }

  // ---- git smart HTTP ----
  const git = /^(\/([^/]+)\/([^/]+?))\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (git) {
    const [, , owner, name, op] = git;
    const r = getRepo(owner, name) ?? createRepo(owner, name);
    const s = storeOf(r);
    if (op === 'info/refs') {
      const svc = new URL(req.url ?? '/', 'http://e').searchParams.get('service') ?? '';
      if (svc === 'git-upload-pack') {
        const adv = pktLine(`# service=git-upload-pack\n`) + Buffer.from('0000') +
          pktLine(`${s.refs.get('refs/heads/main') || '0000000000000000000000000000000000000000'} refs/heads/main\0side-band-64k ofs-delta agent=forge/1`);
        sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', adv as unknown as Buffer, noStore as Record<string, string>);
        return;
      }
      if (svc === 'git-receive-pack') {
        const adv = pktLine(`# service=git-receive-pack\n`) + Buffer.from('0000') +
          pktLine(`${s.refs.get('refs/heads/main') || '0000000000000000000000000000000000000000'} refs/heads/main\0report-status delete-refs ofs-delta agent=forge/1`);
        sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', adv as unknown as Buffer, noStore as Record<string, string>);
        return;
      }
      sendRaw(res, 200, 'text/plain; charset=utf-8', 'dupe refs\n');
      return;
    }
    const body = await readBody(req);
    if (op === 'git-receive-pack') {
      // parse pkt-line commands then pack
      let off = 0; const cmds: { ref: string; newSha: string }[] = [];
      let packBuf: Buffer | null = null;
      for (;;) {
        if (off >= body.length) break;
        const hex = body.toString('latin1', off, off + 4);
        const len = parseInt(hex, 16);
        if (!Number.isFinite(len) || len === 0) { off += 4; break; } // flush-pkt: pack data follows
        const line = body.subarray(off + 4, off + len);
        off += len;
        const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\0\ne]+?)(?:\0.*)?$/.exec(line.toString('utf8'));
        if (m) cmds.push({ newSha: m[2], ref: m[3] });
        void m;
      }
      packBuf = body.subarray(off);
      if (packBuf.length > 12 && packBuf.toString('latin1', 0, 4) === 'PACK') {
        const objs = new Map<string, Buffer>();
        try {
          const count = packBuf.readUInt32BE(8);
          let p = 12;
          for (let i = 0; i < count; i++) {
            let b = packBuf[p++];
            const type = (b >> 4) & 7;
            let size = b & 15, shift = 4;
            while (b & 128) { b = packBuf[p++]; size |= (b & 127) << shift; shift += 7; }
            if (type === 6) { throw new Error('ofs-delta unsupported'); }
            let baseSha: string | null = null;
            if (type === 7) { baseSha = packBuf.toString('latin1', p, p + 20); p += 20; }
            const { out, used } = packConsume(packBuf.subarray(p), size);
            p += used;
            if (type === 7 && baseSha) {
              const baseFull = objs.get(baseSha);
              if (!baseFull) throw new Error('unknown delta base');
              const baseData = baseFull.subarray(baseFull.indexOf(0) + 1);
              const delta = out;
              let doff = 0;
              const readVar = () => { let v = 0, sh = 0; for (;;) { const c = delta[doff++]; v |= (c & 127) << sh; sh += 7; if (!(c & 128)) return v; } };
              readVar(); readVar(); // src size, tgt size
              const ins: number[] = []; const ops: { off: number; len: number }[] = [];
              while (doff < delta.length) {
                const c = delta[doff++];
                if (c & 128) {
                  let o = 0, l = 0;
                  if (c & 16) o |= delta[doff++] << 24;
                  if (c & 32) o |= delta[doff++] << 16;
                  if (c & 64) o |= delta[doff++] << 8;
                  if (c & 8) o |= delta[doff++];
                  if (c & 1) l |= delta[doff++];
                  if (c & 2) l |= delta[doff++] << 8;
                  if (c & 4) l |= delta[doff++] << 16;
                  ops.push({ off: o, len: l === 0 ? 65536 : l });
                } else if (c > 0) { for (let k = 0; k < c; k++) ins.push(delta[doff++]); }
              }
              const parts: Buffer[] = [baseData.subarray(0, 0)];
              let pos = 0;
              for (const op of ops) { parts.push(baseData.subarray(op.off, op.off + op.len)); pos += op.len; }
              const res2 = Buffer.concat([...parts, Buffer.from(ins)]);
              const typeName = 'blob';
              const hdr = Buffer.from(`${typeName === 'commit' || typeName === 'tree' || typeName === 'blob' ? typeName : 'blob'} ${res2.length}\0`);
              const full = Buffer.concat([hdr, res2]);
              objs.set(sha1(full), full);
            } else {
              const typeName = (['blob', 'tree', 'commit', 'tag'] as const)[type - 1] ?? 'blob';
              const hdr = Buffer.from(`${typeName} ${out.length}\0`);
              const full = Buffer.concat([hdr, out]);
              objs.set(sha1(full), full);
            }
          }
          // store objects; heads of commits update branch
          for (const [, full] of objs) s.objects.set(sha1(full), full);
          const commitObjs = [...objs.entries()].filter(([, f]) => f.toString('utf8', 0, 6).startsWith('commit'));
          for (const { ref, newSha } of cmds) {
            if (newSha === '0000000000000000000000000000000000000000') s.refs.delete(ref);
            else { s.refs.set(ref, newSha); const branch = ref.replace('refs/heads/', ''); r.branches.set(branch, newSha); }
          }
          // if a commit object is present but the client sent zero-id cmds (rare), keep refs
          void commitObjs;
        } catch { /* store what we parsed */ for (const [, full] of objs) s.objects.set(sha1(full), full); }
      }
      const rep = pktLine('unpack ok\n') + pktLine(`ok refs/heads/main\n`) + Buffer.from('0000');
      sendRaw(res, 200, 'application/x-git-receive-pack-result', rep as Buffer, noStore as Record<string, string>);
      return;
    }
    if (op === 'git-upload-pack') {
      // minimal: answer want/haves with NAK only (client falls back to full walk; we cannot serve packs we cannot build)
      sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.from('00000008NAK\n' === '' ? '' : '0008NAK\n'), noStore as Record<string, string>);
      return;
    }
  }

  if (!authed(req, res)) return;

  // ---- REST v3 ----
  if (path === '/api/v3' || path === '/api/v3/') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/user') { sendJson(res, 200, userView(VIEWER)); return; }
  if (path === '/api/v3/rate_limit') { sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1795239485 } } }); return; }

  // repo creation
  if (method === 'POST' && (path === '/api/v3/user/repos' || path === '/api/v3/orgs/faint-meadow-org/repos')) {
    const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { name?: string; description?: string | null; private?: boolean };
    if (!b.name) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] }); return; }
    const owner = path.startsWith('/api/v3/orgs/') ? 'faint-meadow-org' : VIEWER.login;
    const r = createRepo(owner, b.name, { description: b.description ?? null, private: b.private ?? false });
    sendJson(res, 201, repoView(r));
    return;
  }
  if (method === 'GET' && (path === '/api/v3/user/repos' || path === '/api/v3/user/repositories')) {
    const mine = [...REPOS.values()].filter((r) => r.owner === VIEWER.login).map(repoView);
    sendJson(res, 200, mine);
    return;
  }

  const rm = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (rm) {
    const [, owner, name, rest] = rm;
    const r = getRepo(owner, name);
    if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
    const sub = (rest ?? '/');

    if (sub === '/' || sub === '') { method === 'GET' ? sendJson(res, 200, repoView(r)) : sendJson(res, 200, repoView(r)); return; }
    if (method === 'PATCH' && sub === '/') { sendJson(res, 200, repoView(r)); return; }

    // branches
    if (sub === '/branches' && method === 'GET') {
      const list = [...r.branches.keys()].map((b) => ({ name: b, commit: { sha: r.branches.get(b) || '0000000000000000000000000000000000000000' }, protected: false }));
      sendJson(res, 200, list); return;
    }
    const br = /^\/branches\/([^/]+)$/.exec(sub);
    if (br && method === 'GET') {
      if (!r.branches.has(br[1])) { sendJson(res, 404, { message: 'Branch not found' }); return; }
      sendJson(res, 200, { name: br[1], commit: { sha: r.branches.get(br[1]) || '0000000000000000000000000000000000000000' }, protected: false });
      return;
    }

    // commits
    if (sub === '/commits' && method === 'GET') {
      const list = [...r.heads.values()].reverse().map((c) => commitView(r, c));
      sendJson(res, 200, list); return;
    }
    const cm = /^\/commits\/([0-9a-f]{7,40})$/.exec(sub);
    if (cm && method === 'GET') {
      const full = [...r.heads.keys()].find((k) => k.startsWith(cm[1]));
      if (!full) { sendJson(res, 404, { message: 'No commit found for SHA' }); return; }
      sendJson(res, 200, commitView(r, r.heads.get(full)!)); return;
    }

    // contents
    if (sub.startsWith('/contents')) {
      const p = sub.slice('/contents'.length).replace(/^\//, '');
      const tree = r.trees.get('main')!;
      if (method === 'GET') {
        const matches = [...tree.values()].filter((f) => f.path === p || (p === '' ? false : f.path.startsWith(p + '/')));
        if (p !== '' && tree.has(p)) {
          const f = tree.get(p)!;
          sendJson(res, 200, { name: f.path.split('/').pop(), path: f.path, sha: f.sha, size: f.size, type: 'file', encoding: 'base64', content: Buffer.from(f.content ?? '', 'utf8').toString('base64'), download_url: `https://example.invalid/raw/${r.owner}/${r.name}/main/${f.path}`, html_url: `https://example.invalid/${r.owner}/${r.name}/blob/main/${f.path}` });
          return;
        }
        const dir = p === '' ? [...tree.values()] : matches;
        if (dir.length === 0) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const entries = dir.filter((f) => f.path === p).map((f) => ({ name: f.path.split('/').pop(), path: f.path, sha: f.sha, size: f.size, type: 'file' }));
        sendJson(res, 200, entries.length ? entries : dir.map((f) => ({ name: f.path.split('/').pop(), path: f.path, sha: f.sha, size: f.size, type: 'file' })));
        return;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { content?: string; message?: string; sha?: string };
        if (method === 'PUT') {
          const content = Buffer.from(b.content ?? '', 'base64');
          const sha = sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
          tree.set(p, { path: p, mode: '100644', type: 'blob', sha, size: content.length, content: content.toString('utf8') });
          sendJson(res, 201, { content: { name: p.split('/').pop(), path: p, sha, size: content.length, type: 'file', encoding: 'base64', content: b.content ?? '' }, commit: { sha: sha, message: b.message ?? 'update' } });
          return;
        }
        const f = tree.get(p);
        if (!f || (b.sha && b.sha !== f.sha)) { sendJson(res, 404, { message: 'Not Found' }); return; }
        tree.delete(p);
        sendJson(res, 200, { commit: { sha: f.sha, message: b.message ?? 'delete' } });
        return;
      }
    }

    // issues
    if (sub === '/issues' && method === 'GET') {
      const state = new URL(req.url ?? '/', 'http://e').searchParams.get('state') ?? 'open';
      const list = [...r.issues.values()].filter((i) => i.state === state || state === 'all').map((i) => issueView(r, i));
      sendJson(res, 200, list); return;
    }
    if (sub === '/issues' && method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { title?: string; body?: string | null; labels?: { name: string }[] | string[] };
      if (b.title == null) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] }); return; }
      const n = r.nextIssue++;
      const labels = (b.labels ?? []).map((l) => ({ name: typeof l === 'string' ? l : l.name }));
      const iss: Issue = { n, number: n, title: b.title, body: b.body ?? null, state: 'open', user: VIEWER, labels, comments: [] };
      r.issues.set(n, iss);
      sendJson(res, 201, issueView(r, iss)); return;
    }
    const im = /^\/issues\/(\d+)$/.exec(sub);
    if (im) {
      const i = r.issues.get(Number(im[1]));
      if (!i) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, issueView(r, i)); return; }
      if (method === 'PATCH') {
        const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { title?: string; body?: string; state?: string };
        if (b.title != null) i.title = b.title;
        if (b.body !== undefined) i.body = b.body;
        if (b.state) i.state = b.state === 'closed' ? 'closed' : 'open';
        sendJson(res, 200, issueView(r, i)); return;
      }
    }
    const icm = /^\/issues\/(\d+)\/comments$/.exec(sub);
    if (icm) {
      const i = r.issues.get(Number(icm[1]));
      if (!i) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, i.comments.map((c) => commentView(r, i, c))); return; }
      if (method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { body?: string };
        if (b.body == null) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] }); return; }
        const c = { n: i.comments.length + 1, user: VIEWER, body: b.body };
        i.comments.push(c);
        sendJson(res, 201, commentView(r, i, c)); return;
      }
    }
    const icm2 = /^\/issues\/comments\/(\d+)$/.exec(sub);
    if (icm2 && method === 'DELETE') {
      for (const i of r.issues.values()) {
        const idx = i.comments.findIndex((c) => 8000 + c.n === Number(icm2[1]));
        if (idx >= 0) { i.comments.splice(idx, 1); sendJson(res, 204, {}); return; }
      }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }

    // labels
    if (sub === '/labels' && method === 'GET') {
      sendJson(res, 200, r.labels.map((l) => ({ id: 900 + l.name.length, name: l.name, color: 'ededed' }))); return;
    }
    if (sub === '/labels' && method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { name?: string };
      if (!b.name) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] }); return; }
      r.labels.push({ name: b.name });
      sendJson(res, 201, { id: 900 + b.name.length, name: b.name, color: 'ededed' }); return;
    }

    // pulls (thin: issues with pull_request marker)
    if (sub === '/pulls' && method === 'GET') {
      sendJson(res, 200, [...r.issues.values()].filter((i) => i.pull_request).map((i) => issueView(r, i))); return;
    }
    if (sub === '/pulls' && method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { title?: string; body?: string | null; head?: string; base?: string };
      if (b.title == null) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }] }); return; }
      const n = r.nextIssue++;
      const iss: Issue = { n, number: n, title: b.title, body: b.body ?? null, state: 'open', user: VIEWER, labels: [], comments: [], pull_request: { url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${n}` } };
      r.issues.set(n, iss);
      sendJson(res, 201, { ...issueView(r, iss), head: { ref: b.head ?? 'main' }, base: { ref: b.base ?? 'main' }, merged: false, draft: false, state: 'open' });
      return;
    }
    const pm = /^\/pulls\/(\d+)$/.exec(sub);
    if (pm && method === 'GET') {
      const i = r.issues.get(Number(pm[1]));
      if (!i || !i.pull_request) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { ...issueView(r, i), head: { ref: 'head' }, base: { ref: 'main' }, merged: false, draft: false, state: i.state });
      return;
    }
    if (sub === '/pulls/comments' && method === 'GET') { sendJson(res, 200, []); return; }

    // collaborators / misc
    if (sub === '/collaborators' && method === 'GET') { sendJson(res, 200, [userView(VIEWER)]); return; }
    if (sub === '/tags' && method === 'GET') { sendJson(res, 200, []); return; }
    if (sub === '/merges' && method === 'POST') { sendJson(res, 409, { message: 'Merge Conflict' }); return; }
    if (sub === '/hooks' && method === 'GET') { sendJson(res, 200, []); return; }
    if (sub === '/languages' && method === 'GET') { sendJson(res, 200, {}); return; }
    if (sub === '/topics' && method === 'GET') { sendJson(res, 200, { names: [] }); return; }
    if (sub === '/stargazers' && method === 'GET') { sendJson(res, 200, []); return; }
    if (sub === '/git/refs' && method === 'GET') {
      sendJson(res, 200, [...r.branches.keys()].map((b) => ({ ref: `refs/heads/${b}`, node_id: 'R_' + b, url: `/api/v3/repos/${r.owner}/${r.name}/git/refs/heads/${b}`, object: { sha: r.branches.get(b) || '0000000000000000000000000000000000000000', type: 'commit' } })));
      return;
    }
    const gref = /^\/git\/refs\/heads\/(.+)$/.exec(sub);
    if (gref && method === 'GET') {
      if (!r.branches.has(gref[1])) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { ref: `refs/heads/${gref[1]}`, url: `/api/v3/repos/${r.owner}/${r.name}/git/refs/heads/${gref[1]}`, object: { sha: r.branches.get(gref[1]) || '0000000000000000000000000000000000000000', type: 'commit' } });
      return;
    }
    if (sub === '/git/commits' && method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { message?: string; tree?: string; parents?: string[] };
      if (!b.tree) { sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Commit', field: 'tree', code: 'missing_field' }] }); return; }
      const sha = sha1(JSON.stringify([b.tree, b.parents ?? [], b.message ?? '', r.owner, r.name]));
      const c: Commit = { sha, message: b.message ?? '', tree: b.tree, parents: b.parents ?? [] };
      r.heads.set(sha, c);
      sendJson(res, 201, commitView(r, c)); return;
    }
    if (sub === '/git/trees' && method === 'POST') {
      const sha = sha1(`${r.owner}/${r.name}/tree`);
      sendJson(res, 201, { sha, tree: [], url: `/api/v3/repos/${r.owner}/${r.name}/git/trees/${sha}` }); return;
    }
    if (sub === '/git/blobs' && method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { content?: string; encoding?: string };
      const raw = b.encoding === 'base64' ? Buffer.from(b.content ?? '', 'base64') : Buffer.from(b.content ?? '', 'utf8');
      const sha = sha1(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw]));
      sendJson(res, 201, { sha, url: `/api/v3/repos/${r.owner}/${r.name}/git/blobs/${sha}` }); return;
    }
    if (sub === '/' && method === 'DELETE') { REPOS.delete(repoKey(r.owner, r.name)); sendJson(res, 204, {}); return; }
    // search-style fallback inside repo
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // search
  if (path === '/api/v3/search/repositories' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://e').searchParams.get('q') ?? '';
    const list = [...REPOS.values()].filter((r) => `${r.owner}/${r.name}`.includes(q.replace(/[^\w./-]/g, ''))).map(repoView);
    sendJson(res, 200, { total_count: list.length, incomplete_results: false, items: list }); return;
  }
  if (path.startsWith('/api/v3/search/') && method === 'GET') {
    sendJson(res, 200, { total_count: 0, incomplete_results: false, items: [] }); return;
  }

  // ---- GraphQL ----
  if (path === '/api/graphql' && method === 'POST') {
    const body = (await readBody(req)).toString('utf8');
    let doc = '';
    try { doc = (JSON.parse(body) as { query?: string }).query ?? ''; } catch { doc = ''; }
    const data: Record<string, unknown> = {};
    const viewerMatch = /viewer/.test(doc);
    if (viewerMatch) {
      const v: Record<string, unknown> = { id: String(VIEWER.id), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, createdAt: FIXED_TIME, url: `https://example.invalid/${VIEWER.login}`, resourcePath: `/${VIEWER.login}` };
      if (/repositories\s*\(/.test(doc) || /repositories\s*\{/.test(doc)) {
        const repos = [...REPOS.values()].filter((r) => r.owner === VIEWER.login);
        v.repositories = { totalCount: repos.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: repos.map((r) => gqlRepo(r)), edges: repos.map((r) => ({ node: gqlRepo(r) })) };
      }
      data.viewer = v;
    }
    const repoMatch = /repository\s*\(\s*owner:\s*"([^"]+)",\s*name:\s*"([^"]+)"/.exec(doc);
    if (repoMatch) {
      const r = getRepo(repoMatch[1], repoMatch[2]);
      data.repository = r ? gqlRepo(r) : null;
    }
    const rateMatch = /rateLimit/.test(doc);
    if (rateMatch) data.rateLimit = { limit: 5000, remaining: 4999, resetAt: FIXED_TIME, cost: 1 };
    sendJson(res, 200, { data });
    return;
  }

  // ---- MCP ----
  if (path === '/mcp' && method === 'POST') {
    const body = (await readBody(req)).toString('utf8');
    let rpc: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try { rpc = JSON.parse(body) as typeof rpc; } catch { sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }); return; }
    const id = rpc.id ?? null;
    const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id, result });
    if (rpc.method === 'initialize') {
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'forge', version: '1.0.0' } });
      return;
    }
    if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    if (rpc.method === 'tools/list') {
      reply({ tools: [
        { name: 'create_repository', description: 'Create a new repository', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
        { name: 'get_me', description: 'Get the authenticated user', inputSchema: { type: 'object', properties: {} } },
        { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
        { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
        { name: 'get_issue', description: 'Get one issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } }, required: ['owner', 'repo', 'issue_number'] } },
        { name: 'add_issue_comment', description: 'Comment on an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' }, body: { type: 'string' } }, required: ['owner', 'repo', 'issue_number', 'body'] } },
        { name: 'create_or_update_file', description: 'Create or update a file', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' } }, required: ['owner', 'repo', 'path', 'content'] } },
        { name: 'get_file_contents', description: 'Get a file', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' } }, required: ['owner', 'repo', 'path'] } },
        { name: 'list_commits', description: 'List commits', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
        { name: 'search_repositories', description: 'Search repositories', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      ] });
      return;
    }
    if (rpc.method === 'tools/call') {
      const name = String(rpc.params?.name ?? '');
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
      const str = (k: string) => (args[k] == null ? '' : String(args[k]));
      const out = (o: unknown) => reply({ content: [{ type: 'text', text: JSON.stringify(o) }] });
      if (name === 'get_me') { out(userView(VIEWER)); return; }
      if (name === 'create_repository') { const r = createRepo(VIEWER.login, str('name'), { description: str('description') || null, private: args.private === true }); out(repoView(r)); return; }
      const r = getRepo(str('owner'), str('repo'));
      if (!r) { reply({ content: [{ type: 'text', text: 'Not Found' }], isError: true }); return; }
      if (name === 'list_issues') { out([...r.issues.values()].map((i) => issueView(r, i))); return; }
      if (name === 'get_issue') { const i = r.issues.get(Number(str('issue_number'))); i ? out(issueView(r, i)) : reply({ content: [{ type: 'text', text: 'Not Found' }], isError: true }); return; }
      if (name === 'create_issue') { const n = r.nextIssue++; const iss: Issue = { n, number: n, title: str('title'), body: str('body') || null, state: 'open', user: VIEWER, labels: [], comments: [] }; r.issues.set(n, iss); out(issueView(r, iss)); return; }
      if (name === 'add_issue_comment') { const i = r.issues.get(Number(str('issue_number'))); if (!i) { reply({ content: [{ type: 'text', text: 'Not Found' }], isError: true }); return; } const c = { n: i.comments.length + 1, user: VIEWER, body: str('body') }; i.comments.push(c); out(commentView(r, i, c)); return; }
      if (name === 'create_or_update_file') { const p = str('path'); const raw = Buffer.from(str('content'), 'utf8'); const sha = sha1(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw])); r.trees.get('main')!.set(p, { path: p, mode: '100644', type: 'blob', sha, size: raw.length, content: str('content') }); out({ commit: { sha, message: str('message') || 'update' }, content: { path: p, sha } }); return; }
      if (name === 'get_file_contents') { const f = r.trees.get('main')!.get(str('path')); f ? out({ path: f.path, sha: f.sha, content: Buffer.from(f.content ?? '', 'utf8').toString('base64'), encoding: 'base64' }) : reply({ content: [{ type: 'text', text: 'Not Found' }], isError: true }); return; }
      if (name === 'list_commits') { out([...r.heads.values()].reverse().map((c) => commitView(r, c))); return; }
      if (name === 'search_repositories') { out({ total_count: REPOS.size, items: [...REPOS.values()].map(repoView) }); return; }
      reply({ content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
      return;
    }
    if (rpc.method === 'ping') { reply({}); return; }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function gqlRepo(r: Repo): Record<string, unknown> {
  const issues = [...r.issues.values()];
  return {
    id: `R_${r.owner}_${r.name}`, name: r.name, nameWithOwner: `${r.owner}/${r.name}`,
    description: r.description, isPrivate: r.private, isFork: false, createdAt: FIXED_TIME,
    url: `https://example.invalid/${r.owner}/${r.name}`, defaultBranchRef: { name: 'main' },
    issues: {
      totalCount: issues.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: issues.map((i) => ({ id: `I_${r.name}_${i.n}`, number: i.n, title: i.title, body: i.body, state: i.state.toUpperCase(), createdAt: FIXED_TIME, author: { login: i.user.login }, comments: { totalCount: i.comments.length } })),
    },
    object: null,
  };
}
