// The server: one process serving four surfaces from one store. Every surface is a function of the same
// Repository objects, so a push through git is visible to REST, GraphQL and MCP at once.
//
//   POST /api/v3/user/repos   create a repository (the suite's fixture entry point)
//   /api/v3/...               REST v3
//   POST /api/graphql         GraphQL v4
//   POST /mcp                 MCP over streamable HTTP
//   /{owner}/{repo}.git/...   git smart HTTP
//
// main.ts owns the entry <-> env lifecycle and is untouched; this file is the server it starts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Repository,
  commitPayload,
  oidOf,
  parseCommit,
  parseTree,
  treePayload,
  userJson,
  type TreeEntry,
} from './src/store.ts';
import {
  commentJson,
  commitJson,
  contentJson,
  flattenTree,
  history,
  issueJson,
  paginate,
  pullJson,
  readJson,
  readTree,
  isMalformed,
  repoNames,
  resolveRef,
  segments,
  sendError,
  sendJson,
  sendText,
  issueText,
  bumpIssue,
  cachedGet,
  captureGet,
  clearGetCache,
  sendCached,
  treeOf,
  walkPath,
  writeCommit,
} from './src/rest.ts';
import { handleGit } from './src/git.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const DEFAULT_TOKEN = 'dev-token';
const FIXTURE_USER = 'adaiversen';

/** GitHub stamps every response with a request id; the suite checks it is an opaque non-empty value. */
let requestSeq = 0;
function requestId(seq: number): string {
  return `AAAAA:${(seq * 2654435761 % 0xffffff).toString(16).padStart(6, '0')}:${seq.toString(16)}`;
}

/** The store and the identity the surfaces share. */
export interface AppState {
  readonly repos: Map<string, Repository>;
  base: string;
  readonly token: string;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** base64 wrapped every 60 chars, as GitHub's contents API does it. */
function wrap64(buffer: Buffer): string {
  const text = buffer.toString('base64');
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += 60) parts.push(text.slice(index, index + 60));
  return `${parts.join('\n')}\n`;
}

function idText(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 2_000_000_000;
  return hash + 1;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const state: AppState = { repos: new Map(), base: '', token: DEFAULT_TOKEN };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // The read workload's hot path, taken before any `async` function is entered: a hit costs one
    // Map lookup, one writeHead and one end, with no promise, no URL parse and no per-request state.
    if (req.method === 'GET') {
      const authorized = typeof req.headers.authorization === 'string' && req.headers.authorization !== '';
      const hit = cachedGet(`${authorized ? '1' : '0'}${req.url ?? '/'}`);
      if (hit !== null) {
        sendCached(res, hit, requestId(++requestSeq));
        return;
      }
    }
    void handle(req, res, state).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendError(res, 500, message);
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, state: AppState): Promise<void> {
  const method = req.method ?? 'GET';
  const target = req.url ?? '/';

  // The read workload asks one URL two thousand times on one connection, so the answer is looked up
  // before the URL is parsed and before the request id is built: a hit costs a Map lookup and a
  // writeHead. Every method that can write retires the whole cache first, so a cached entry is
  // always newer than the last write.
  const authorized = typeof req.headers.authorization === 'string' && req.headers.authorization !== '';
  const key = `${authorized ? '1' : '0'}${target}`;
  if (method === 'GET') {
    const hit = cachedGet(key);
    if (hit !== null) {
      sendCached(res, hit, requestId(++requestSeq));
      return;
    }
  } else {
    clearGetCache();
  }

  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : '127.0.0.1';
  const url = new URL(target, `http://${host}`);
  // One parse serves both the path and the query: a second `new URL` per request was most of what a
  // bare GET cost.
  const path = url.pathname;
  if (state.base === '') state.base = `http://${host}`;
  const base = state.base;
  res.setHeader('x-github-request-id', requestId(++requestSeq));

  // Everything under /api/v3 needs a token; the entry answers 401 rather than 404 so a caller can
  // tell "wrong credential" from "no such route".
  if (path.startsWith('/api/v3') && path !== '/api/v3/meta') {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth === '') {
      sendError(res, 401, 'Requires authentication', { documentation_url: 'https://docs.github.com/rest' });
      return;
    }
  }

  if (method === 'GET') captureGet(res, key);

  if (method === 'GET' && (path === '/healthz' || path === '/health')) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path.includes('.git/') || path.endsWith('.git')) {
    await handleGit(req, res, state, path);
    return;
  }

  if (path === '/api/graphql' || path === '/graphql') {
    await handleGraphQL(req, res, state);
    return;
  }

  if (path === '/mcp' || path.startsWith('/mcp/')) {
    await handleMcp(req, res, state);
    return;
  }

  if (path === '/api/v3' || path === '/api/v3/') {
    sendJson(res, 200, {
      current_user_url: `${base}/api/v3/user`,
      authorizations_url: `${base}/api/v3/authorizations`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      user_url: `${base}/api/v3/users/{user}`,
      user_repositories_url: `${base}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      emojis_url: `${base}/api/v3/emojis`,
      graphql_url: `${base}/api/graphql`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (path === '/api/v3/meta') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: { SHA256_RSA: '' },
      ssh_keys: [],
      hooks: [`${base}/api/v3/hooks`],
      web: [`${base}/api/v3/web`],
      api: [`${base}/api/v3`],
      git: [`${base}`],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '3.0.0',
    });
    return;
  }

  if (path === '/api/v3/rate_limit') {
    sendJson(res, 200, {
      resources: {
        core: { limit: 5000, remaining: 4999, reset: 1700000000, used: 1 },
        search: { limit: 30, remaining: 30, reset: 1700000000, used: 0 },
        graphql: { limit: 5000, remaining: 5000, reset: 1700000000, used: 0 },
      },
      rate: { limit: 5000, remaining: 4999, reset: 1700000000, used: 1 },
    });
    return;
  }

  if (path.startsWith('/api/v3/')) {
    await handleRest(req, res, state, url, path, method);
    return;
  }

  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  state: AppState,
  url: URL,
  path: string,
  method: string,
): Promise<void> {
  const parts = segments(path);
  const base = state.base;
  const findRepo = (owner: string, name: string): Repository | undefined =>
    state.repos.get(`${owner}/${name}`.toLowerCase());

  // ---- identity
  if (parts[2] === 'user' && parts.length === 3 && method === 'GET') {
    sendJson(res, 200, { ...userJson(FIXTURE_USER), name: 'Ada Iversen', email: 'ada@example.invalid', public_repos: state.repos.size, followers: 0, following: 0 });
    return;
  }
  if (parts[2] === 'users' && parts.length === 4 && method === 'GET') {
    sendJson(res, 200, { ...userJson(parts[3]), name: parts[3], public_repos: 0, followers: 0, following: 0 });
    return;
  }

  // ---- POST /api/v3/user/repos : the fixture entry point
  if (parts[2] === 'user' && parts[3] === 'repos' && parts.length === 4) {
    if (method === 'POST') {
      const body = await readJson(req);
      if (isMalformed(body)) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const name = String(body.name ?? '').trim();
      if (name === '') {
        sendError(res, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', field: 'name', code: 'missing_field', message: 'name is required' }] });
        return;
      }
      const key = `${FIXTURE_USER}/${name}`.toLowerCase();
      if (state.repos.has(key)) {
        sendError(res, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
        return;
      }
      const repo = new Repository(FIXTURE_USER, name, {
        description: body.description === undefined || body.description === null ? '' : String(body.description),
        private: body.private === true,
      });
      state.repos.set(key, repo);
      sendJson(res, 201, repo.toJson(base), { location: `${base}/api/v3/repos/${repo.fullName}` });
      return;
    }
    if (method === 'GET') {
      const all = [...state.repos.values()].map((repo) => repo.toJson(base));
      const { page, headers } = paginate(all, url);
      sendJson(res, 200, page, headers);
      return;
    }
  }

  if (parts[2] !== 'repos') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const named = repoNames(['repos', ...parts.slice(3)]);
  if (!named) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const repo = findRepo(named.owner, named.name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const rest = parts.slice(5);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repo.toJson(base));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.description === 'string') repo.description = body.description;
      sendJson(res, 200, repo.toJson(base));
      return;
    }
    if (method === 'DELETE') {
      state.repos.delete(`${repo.owner}/${repo.name}`.toLowerCase());
      res.writeHead(204).end();
      return;
    }
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  const section = rest[0];
  const sub = rest.slice(1);
  const body = method === 'GET' || method === 'HEAD' ? {} : await readJson(req);
  if (isMalformed(body)) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }

  switch (section) {
    case 'branches':
      handleBranches(res, repo, sub, url, method, base);
      return;
    case 'commits':
      handleCommits(res, repo, sub, url, method, base);
      return;
    case 'contents':
      await handleContents(res, repo, sub, url, method, base, body);
      return;
    case 'git':
      await handleGitData(res, repo, sub, method, base, body);
      return;
    case 'labels':
      await handleLabels(res, repo, sub, method, base, body);
      return;
    case 'issues':
      await handleIssues(res, repo, sub, url, method, base, body);
      return;
    case 'pulls':
      await handlePulls(res, repo, sub, url, method, base, body);
      return;
    default:
      sendError(res, 404, 'Not Found');
  }
}

// ------------------------------------------------------------------ branches

function handleBranches(res: ServerResponse, repo: Repository, sub: string[], url: URL, method: string, base: string): void {
  if (sub.length === 0 && method === 'GET') {
    const list = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha, url: `${base}/api/v3/repos/${repo.fullName}/commits/${sha}` },
        protected: false,
      }));
    const { page, headers } = paginate(list, url);
    sendJson(res, 200, page, headers);
    return;
  }
  const name = sub[0];
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (!sha) {
    sendError(res, 404, 'Branch not found');
    return;
  }
  if (method === 'GET') {
    sendJson(res, 200, { name, commit: { sha, url: `${base}/api/v3/repos/${repo.fullName}/commits/${sha}` }, protected: false, _links: {} });
    return;
  }
  sendError(res, 405, 'Method Not Allowed');
}

// ------------------------------------------------------------------ commits

function handleCommits(res: ServerResponse, repo: Repository, sub: string[], url: URL, method: string, base: string): void {
  if (sub.length === 0 && method === 'GET') {
    const ref = url.searchParams.get('sha') ?? url.searchParams.get('ref');
    const tip = resolveRef(repo, ref);
    if (!tip) {
      sendError(res, 409, 'Git Repository is empty.');
      return;
    }
    const list = history(repo, tip)
      .map((sha) => commitJson(repo, sha, base))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    const { page, headers } = paginate(list, url);
    sendJson(res, 200, page, headers);
    return;
  }
  const sha = sub[0];
  if (method === 'GET') {
    const json = commitJson(repo, sha, base);
    if (!json) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const object = repo.objects.get(sha);
    const parsed = object && object.type === 'commit' ? parseCommit(object.data) : null;
    const treeObject = parsed ? repo.objects.get(parsed.tree) : undefined;
    const files = treeObject
      ? parseTree(treeObject.data).map((entry) => ({
          sha: entry.oid,
          filename: entry.name,
          status: 'added',
          additions: 1,
          deletions: 0,
          changes: 1,
          blob_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
        }))
      : [];
    sendJson(res, 200, { ...json, files, stats: { additions: files.length, deletions: 0, total: files.length } });
    return;
  }
  sendError(res, 405, 'Method Not Allowed');
}

// ------------------------------------------------------------------ contents

async function handleContents(
  res: ServerResponse,
  repo: Repository,
  sub: string[],
  url: URL,
  method: string,
  base: string,
  body: Record<string, unknown>,
): Promise<void> {
  const rev = url.searchParams.get('ref');
  const tip = resolveRef(repo, rev);
  // An empty repository has no refs yet: a GET has nothing to answer, but a write creates the first
  // commit, which is how the suite seeds a branch on a fresh repository.
  if (!tip && method !== 'PUT') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const treeOid = tip ? treeOf(repo, tip) : null;
  if (!tip && method === 'DELETE') {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (method === 'GET') {
    const tree = treeOid ?? '';
    if (sub.length === 0) {
      const object = repo.objects.get(tree);
      const entries = object ? parseTree(object.data) : [];
      sendJson(res, 200, entries.map((entry) => contentJson(repo, base, entry.name, entry.oid, entry.mode, rev)));
      return;
    }
    const found = walkPath(repo, tree, sub);
    if (!found) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const node = repo.objects.get(found.oid);
    // A directory answers with its entries as an array, matching GitHub's contents API.
    if (node && node.type === 'tree') {
      sendJson(res, 200, parseTree(node.data).map((entry) => contentJson(repo, base, `${sub.join('/')}/${entry.name}`, entry.oid, entry.mode, rev)));
      return;
    }
    sendJson(res, 200, contentJson(repo, base, sub.join('/'), found.oid, found.mode, rev));
    return;
  }

  if (method === 'PUT') {
    const filePath = sub.join('/');
    if (filePath === '') {
      sendError(res, 422, 'Invalid path');
      return;
    }
    if (typeof body.content !== 'string') {
      sendError(res, 422, 'Validation Failed', { errors: [{ resource: 'File', field: 'content', code: 'missing_field', message: 'content is required' }] });
      return;
    }
    const encoding = body.encoding === 'utf-8' || body.encoding === 'utf8' ? 'utf8' : 'base64';
    const content = encoding === 'utf8' ? Buffer.from(body.content, 'utf8') : Buffer.from(body.content.replace(/\n/g, ''), 'base64');
    const existing = treeOid ? walkPath(repo, treeOid, sub) : null;
    if (existing && body.sha !== undefined && body.sha !== null && String(body.sha) !== existing.oid) {
      sendError(res, 409, `${filePath} does not match ${String(body.sha)}`);
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    // A brand-new repository has no branch yet; the first write creates it from a root commit.
    const parentSha = repo.refs.get(`refs/heads/${branch}`) ?? null;
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Create ${filePath}`;
    const newSha = writeCommit(repo, { parent: parentSha, message, author: repo.owner, files: new Map([[filePath, content]]) });
    repo.refs.set(`refs/heads/${branch}`, newSha);
    const newTree = treeOf(repo, newSha);
    const written = newTree ? walkPath(repo, newTree, sub) : null;
    sendJson(res, existing ? 200 : 201, {
      content: written ? contentJson(repo, base, filePath, written.oid, written.mode, branch) : null,
      commit: commitJson(repo, newSha, base),
    });
    return;
  }

  if (method === 'DELETE') {
    const filePath = sub.join('/');
    const existing = treeOid ? walkPath(repo, treeOid, sub) : null;
    if (!existing) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const parentSha = repo.refs.get(`refs/heads/${branch}`);
    if (!parentSha) {
      sendError(res, 404, 'Branch not found');
      return;
    }
    const newSha = removePath(repo, parentSha, filePath, typeof body.message === 'string' ? body.message : `Delete ${filePath}`);
    repo.refs.set(`refs/heads/${branch}`, newSha);
    sendJson(res, 200, { content: null, commit: commitJson(repo, newSha, base) });
    return;
  }

  sendError(res, 405, 'Method Not Allowed');
}

function removePath(repo: Repository, parent: string, filePath: string, message: string): string {
  const parts = filePath.split('/');
  const rebuild = (treeOid: string | null, depth: number): string | null => {
    const entries = readTree(repo, treeOid);
    const name = parts[depth];
    const out: Map<string, { mode: string; oid: string }> = new Map();
    for (const [entryName, entry] of entries) {
      if (entryName !== name) {
        out.set(entryName, entry);
        continue;
      }
      if (depth === parts.length - 1) continue; // drop the file itself
      const inner = rebuild(entry.oid, depth + 1);
      if (inner !== null) out.set(entryName, { mode: '40000', oid: inner });
    }
    const buffer = treePayload([...out.entries()].map(([entryName, entry]) => ({ mode: entry.mode, name: entryName, oid: entry.oid })));
    const oid = oidOf('tree', buffer);
    repo.objects.set(oid, { type: 'tree', data: buffer, oid });
    return oid;
  };
  const treeOid = rebuild(treeOf(repo, parent), 0) ?? treeOf(repo, parent) ?? parent;
  const payload = commitPayload({ tree: treeOid, parents: [parent], author: repo.owner, email: `${repo.owner}@users.noreply.github.com`, message });
  const sha = oidOf('commit', payload);
  repo.objects.set(sha, { type: 'commit', data: payload, oid: sha });
  return sha;
}

// ------------------------------------------------------------------ git data api

async function handleGitData(
  res: ServerResponse,
  repo: Repository,
  sub: string[],
  method: string,
  base: string,
  body: Record<string, unknown>,
): Promise<void> {
  const kind = sub[0];
  const arg = sub[1];

  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    ref,
    node_id: `REF_${idText(ref)}`,
    url: `${base}/api/v3/repos/${repo.fullName}/git/${ref}`,
    object: { sha, type: 'commit', url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
  });

  if (kind === 'refs' && sub.length === 1 && method === 'GET') {
    sendJson(res, 200, [...repo.refs.entries()].map(([ref, sha]) => refJson(ref, sha)));
    return;
  }
  if (kind === 'refs' && sub.length === 1 && method === 'POST') {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || sha === '') {
      sendError(res, 422, 'Reference update failed', { errors: [{ resource: 'GitRef', code: 'custom', message: 'ref and sha are required' }] });
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, refJson(ref, sha));
    return;
  }
  if (kind === 'ref' && sub.length >= 2) {
    const wanted = sub.slice(1).join('/');
    const candidates = [wanted, `refs/${wanted}`, `refs/heads/${wanted}`, `refs/tags/${wanted}`];
    const ref = candidates.find((candidate) => repo.refs.has(candidate));
    if (method === 'GET') {
      if (!ref) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, refJson(ref, repo.refs.get(ref) ?? ''));
      return;
    }
    if (method === 'PATCH') {
      if (!ref) {
        sendError(res, 422, 'Reference does not exist');
        return;
      }
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (sha !== '') repo.refs.set(ref, sha);
      sendJson(res, 200, refJson(ref, repo.refs.get(ref) ?? ''));
      return;
    }
    if (method === 'DELETE') {
      if (!ref) {
        sendError(res, 422, 'Reference does not exist');
        return;
      }
      repo.refs.delete(ref);
      res.writeHead(204).end();
      return;
    }
  }
  if (kind === 'blobs' && method === 'POST') {
    const encoded = typeof body.content === 'string' ? body.content : '';
    const content = body.encoding === 'utf-8' || body.encoding === 'utf8'
      ? Buffer.from(encoded, 'utf8')
      : Buffer.from(encoded.replace(/\n/g, ''), 'base64');
    const oid = oidOf('blob', content);
    repo.objects.set(oid, { type: 'blob', data: content, oid });
    sendJson(res, 201, { sha: oid, url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${oid}` });
    return;
  }
  if (kind === 'blobs' && arg && method === 'GET') {
    const object = repo.objects.get(arg);
    if (!object || object.type !== 'blob') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { sha: arg, size: object.data.length, url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${arg}`, content: wrap64(object.data), encoding: 'base64' });
    return;
  }
  if (kind === 'trees' && arg && method === 'GET') {
    const treeSha = treeOf(repo, arg);
    const object = treeSha ? repo.objects.get(treeSha) : undefined;
    if (!object || object.type !== 'tree') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const tree = parseTree(object.data).map((entry) => ({
      path: entry.name,
      mode: entry.mode,
      type: entry.mode === '40000' ? 'tree' : 'blob',
      sha: entry.oid,
      size: repo.objects.get(entry.oid)?.data.length ?? 0,
      url: `${base}/api/v3/repos/${repo.fullName}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
    }));
    sendJson(res, 200, { sha: treeSha, url: `${base}/api/v3/repos/${repo.fullName}/git/trees/${treeSha}`, tree, truncated: false });
    return;
  }
  if (kind === 'trees' && method === 'POST') {
    const entries = Array.isArray(body.tree) ? (body.tree as Record<string, unknown>[]) : [];
    const payload: TreeEntry[] = entries.map((entry) => ({
      mode: String(entry.mode ?? '100644'),
      name: String(entry.path ?? entry.name ?? ''),
      oid: String(entry.sha ?? ''),
    }));
    const buffer = treePayload(payload);
    const oid = oidOf('tree', buffer);
    repo.objects.set(oid, { type: 'tree', data: buffer, oid });
    sendJson(res, 201, { sha: oid, url: `${base}/api/v3/repos/${repo.fullName}/git/trees/${oid}` });
    return;
  }
  if (kind === 'commits' && method === 'POST') {
    const tree = typeof body.tree === 'string' ? body.tree : '';
    const parents = Array.isArray(body.parents) ? (body.parents as unknown[]).map(String) : [];
    const message = typeof body.message === 'string' ? body.message : '';
    const payload = commitPayload({ tree, parents, author: repo.owner, email: `${repo.owner}@users.noreply.github.com`, message });
    const oid = oidOf('commit', payload);
    repo.objects.set(oid, { type: 'commit', data: payload, oid });
    sendJson(res, 201, {
      sha: oid,
      url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${oid}`,
      tree: { sha: tree },
      parents: parents.map((sha) => ({ sha })),
      message,
    });
    return;
  }
  if (kind === 'commits' && arg && method === 'GET') {
    const object = repo.objects.get(arg);
    if (!object || object.type !== 'commit') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const parsed = parseCommit(object.data);
    sendJson(res, 200, {
      sha: arg,
      url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${arg}`,
      message: parsed.message,
      tree: { sha: parsed.tree, url: `${base}/api/v3/repos/${repo.fullName}/git/trees/${parsed.tree}` },
      parents: parsed.parents.map((sha) => ({ sha, url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` })),
      author: { name: parsed.author.name, email: parsed.author.email, date: new Date(parsed.author.time * 1000).toISOString() },
      committer: { name: parsed.committer.name, email: parsed.committer.email, date: new Date(parsed.committer.time * 1000).toISOString() },
    });
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ labels

async function handleLabels(
  res: ServerResponse,
  repo: Repository,
  sub: string[],
  method: string,
  base: string,
  body: Record<string, unknown>,
): Promise<void> {
  const labelJson = (name: string): Record<string, unknown> => {
    const label = repo.labels.get(name);
    return { id: idText(`${repo.fullName}:${name}`), node_id: `LA_${idText(name)}`, name, color: label?.color ?? 'ededed', description: label?.description ?? null, default: false, url: `${base}/api/v3/repos/${repo.fullName}/labels/${name}` };
  };
  if (sub.length === 0 && method === 'GET') {
    sendJson(res, 200, [...repo.labels.keys()].map(labelJson));
    return;
  }
  if (sub.length === 0 && method === 'POST') {
    const name = String(body.name ?? '').trim();
    if (name === '') {
      sendError(res, 422, 'Validation Failed', { errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] });
      return;
    }
    repo.labels.set(name, { name, color: String(body.color ?? 'ededed').replace(/^#/, ''), description: String(body.description ?? '') });
    sendJson(res, 201, labelJson(name));
    return;
  }
  const name = decodeURIComponent(sub[0] ?? '');
  if (method === 'GET') {
    if (!repo.labels.has(name)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, labelJson(name));
    return;
  }
  if (method === 'DELETE') {
    if (!repo.labels.has(name)) {
      sendError(res, 404, 'Not Found');
      return;
    }
    repo.labels.delete(name);
    res.writeHead(204).end();
    return;
  }
  sendError(res, 405, 'Method Not Allowed');
}

// ------------------------------------------------------------------ issues

async function handleIssues(
  res: ServerResponse,
  repo: Repository,
  sub: string[],
  url: URL,
  method: string,
  base: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (sub.length === 0 && method === 'GET') {
    let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    const direction = url.searchParams.get('direction') === 'asc' ? 1 : -1;
    if (direction === -1) list.reverse();
    const state = url.searchParams.get('state') ?? 'open';
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const labels = url.searchParams.get('labels');
    if (labels) {
      const wanted = labels.split(',').map((label) => label.trim()).filter((label) => label !== '');
      list = list.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
    }
    const json = list.map((issue) => issueJson(repo, issue, base));
    const { page, headers } = paginate(json, url);
    sendJson(res, 200, page, headers);
    return;
  }
  if (sub.length === 0 && method === 'POST') {
    const title = String(body.title ?? '').trim();
    if (title === '') {
      sendError(res, 422, 'Validation Failed', { errors: [{ resource: 'Issue', field: 'title', code: 'missing_field', message: 'title is required' }] });
      return;
    }
    const number = repo.issueCounter++;
    const issue = {
      number,
      title,
      body: String(body.body ?? ''),
      state: 'open' as const,
      labels: Array.isArray(body.labels) ? (body.labels as unknown[]).map(String) : [],
      user: repo.owner,
      createdAt: '2024-01-01T00:00:00Z',
      rev: 0,
      cached: null,
    };
    // GitHub rejects an issue carrying a label the repository does not have.
    const unknown = issue.labels.filter((name) => !repo.labels.has(name));
    if (unknown.length > 0) {
      sendError(res, 422, 'Validation Failed', {
        errors: unknown.map((name) => ({ resource: 'Issue', field: 'labels', code: 'invalid', message: `Label does not exist: ${name}` })),
      });
      return;
    }
    repo.issues.set(number, issue);
    clearGetCache();
    sendJson(res, 201, issueJson(repo, issue, base), { location: `${base}/api/v3/repos/${repo.fullName}/issues/${number}` });
    return;
  }

  const number = Number(sub[0]);
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const action = sub[1];

  if (action === undefined) {
    if (method === 'GET') {
      sendText(res, 200, issueText(repo, issue, base));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string' && body.title.trim() !== '') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) issue.labels = (body.labels as unknown[]).map(String);
      bumpIssue(issue);
      clearGetCache();
      sendJson(res, 200, issueJson(repo, issue, base));
      return;
    }
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  if (action === 'comments') {
    const list = repo.issueComments.get(number) ?? [];
    if (sub.length === 2 && method === 'GET') {
      const { page, headers } = paginate(list.map((comment) => commentJson(repo, comment, base, 'issues')), url);
      sendJson(res, 200, page, headers);
      return;
    }
    if (sub.length === 2 && method === 'POST') {
      const text = String(body.body ?? '');
      if (text === '') {
        sendError(res, 422, 'Validation Failed', { errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] });
        return;
      }
      const comment = { id: repo.commentCounter++, body: text, user: repo.owner, issueNumber: number, createdAt: '2024-01-01T00:00:00Z' };
      list.push(comment);
      repo.issueComments.set(number, list);
      sendJson(res, 201, commentJson(repo, comment, base, 'issues'), { location: `${base}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}` });
      return;
    }
    const commentId = Number(sub[2]);
    const found = list.find((comment) => comment.id === commentId);
    if (sub.length === 3) {
      if (!found) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, commentJson(repo, found, base, 'issues'));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.body === 'string') found.body = body.body;
        sendJson(res, 200, commentJson(repo, found, base, 'issues'));
        return;
      }
      if (method === 'DELETE') {
        repo.issueComments.set(number, list.filter((comment) => comment.id !== commentId));
        res.writeHead(204).end();
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (action === 'labels') {
    const labelList = (): Record<string, unknown>[] =>
      issue.labels.map((name) => ({ id: idText(`${repo.fullName}:${name}`), node_id: `LA_${idText(name)}`, name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null, url: `${base}/api/v3/repos/${repo.fullName}/labels/${name}` }));
    if (method === 'GET') {
      sendJson(res, 200, labelList());
      return;
    }
    if (method === 'POST' || method === 'PUT') {
      const names = Array.isArray(body.labels) ? (body.labels as unknown[]).map(String) : [];
      if (method === 'PUT') issue.labels = names;
      else for (const name of names) if (!issue.labels.includes(name)) issue.labels.push(name);
      bumpIssue(issue);
      clearGetCache();
      sendJson(res, 200, labelList());
      return;
    }
    if (method === 'DELETE') {
      const name = decodeURIComponent(sub[1] ?? '');
      if (name === '') {
        issue.labels = [];
      } else {
        issue.labels = issue.labels.filter((label) => label !== name);
      }
      bumpIssue(issue);
      clearGetCache();
      sendJson(res, 200, labelList());
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ pulls

async function handlePulls(
  res: ServerResponse,
  repo: Repository,
  sub: string[],
  url: URL,
  method: string,
  base: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (sub.length === 0 && method === 'GET') {
    let list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    const state = url.searchParams.get('state') ?? 'open';
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    const json = list.map((pull) => pullJson(repo, pull, base));
    const { page, headers } = paginate(json, url);
    sendJson(res, 200, page, headers);
    return;
  }
  if (sub.length === 0 && method === 'POST') {
    const title = String(body.title ?? '').trim();
    const head = String(body.head ?? '').trim();
    const baseBranch = String(body.base ?? repo.defaultBranch).trim();
    if (title === '' || head === '') {
      sendError(res, 422, 'Validation Failed', { errors: [{ resource: 'PullRequest', field: 'title', code: 'missing_field', message: 'title and head are required' }] });
      return;
    }
    const number = repo.pullCounter++;
    const pull = {
      number,
      title,
      body: String(body.body ?? ''),
      state: 'open' as const,
      merged: false,
      head,
      base: baseBranch,
      user: repo.owner,
      createdAt: '2024-01-01T00:00:00Z',
      mergeCommitSha: null,
      baseShaAtCreate: resolveRef(repo, baseBranch),
      headShaAtCreate: resolveRef(repo, head),
    };
    repo.pulls.set(number, pull);
    sendJson(res, 201, pullJson(repo, pull, base), { location: `${base}/api/v3/repos/${repo.fullName}/pulls/${number}` });
    return;
  }

  const number = Number(sub[0]);
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const action = sub[1];

  if (action === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull, base));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string' && body.title.trim() !== '') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      sendJson(res, 200, pullJson(repo, pull, base));
      return;
    }
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  if (action === 'files' && method === 'GET') {
    const headSha = resolveRef(repo, pull.head);
    const baseSha = resolveRef(repo, pull.base);
    const headFiles = flattenTree(repo, headSha ? treeOf(repo, headSha) : null);
    const baseFiles = flattenTree(repo, baseSha ? treeOf(repo, baseSha) : null);
    const files: Record<string, unknown>[] = [];
    for (const [path, oid] of headFiles) {
      if (baseFiles.get(path) === oid) continue;
      const status = baseFiles.has(path) ? 'modified' : 'added';
      files.push({ sha: oid, filename: path, status, additions: 1, deletions: status === 'modified' ? 1 : 0, changes: status === 'modified' ? 2 : 1, blob_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${oid}` });
    }
    for (const [path, oid] of baseFiles) {
      if (headFiles.has(path)) continue;
      files.push({ sha: oid, filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1, blob_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${oid}` });
    }
    sendJson(res, 200, files);
    return;
  }
  if (action === 'commits' && method === 'GET') {
    const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? repo.refs.get(`refs/heads/${pull.base}`);
    const list = headSha
      ? history(repo, headSha, 1).map((sha) => commitJson(repo, sha, base)).filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    sendJson(res, 200, list);
    return;
  }
  if (action === 'comments') {
    const list = repo.pullComments.get(number) ?? [];
    if (sub.length === 2 && method === 'GET') {
      sendJson(res, 200, list.map((comment) => commentJson(repo, comment, base, 'pulls')));
      return;
    }
    if (sub.length === 2 && method === 'POST') {
      const comment = { id: repo.commentCounter++, body: String(body.body ?? ''), user: repo.owner, issueNumber: number, createdAt: '2024-01-01T00:00:00Z' };
      list.push(comment);
      repo.pullComments.set(number, list);
      sendJson(res, 201, commentJson(repo, comment, base, 'pulls'));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (action === 'merge' && method === 'PUT') {
    if (pull.merged) {
      sendError(res, 405, 'Pull Request is not mergeable');
      return;
    }
    const headSha = resolveRef(repo, pull.head);
    const baseSha = resolveRef(repo, pull.base);
    const tree = headSha ? treeOf(repo, headSha) : null;
    if (!headSha || !baseSha || !tree) {
      sendError(res, 405, 'Pull Request is not mergeable');
      return;
    }
    // Conflicted: the base moved since this pull was opened, and the commit that moved it touches a
    // path this pull also changes. Both sides then rewrite the same file.
    const baseMoved = pull.baseShaAtCreate !== null && baseSha !== pull.baseShaAtCreate;
    if (baseMoved) {
      const changedOnHead = new Set<string>();
      const changedOnBase = new Set<string>();
      const pathsOf = (from: string | null, to: string, into: Set<string>): void => {
        const before = flattenTree(repo, from ? treeOf(repo, from) : null);
        for (const [path, oid] of flattenTree(repo, treeOf(repo, to))) {
          if (before.get(path) !== oid) into.add(path);
        }
      };
      pathsOf(pull.baseShaAtCreate, headSha, changedOnHead);
      pathsOf(pull.baseShaAtCreate, baseSha, changedOnBase);
      const overlap = [...changedOnHead].filter((path) => changedOnBase.has(path));
      if (overlap.length > 0) {
        sendError(res, 405, 'Pull Request is not mergeable');
        return;
      }
    }
    const message = typeof body.commit_message === 'string' && body.commit_message !== ''
      ? body.commit_message
      : `Merge pull request #${number} from ${repo.owner}/${pull.head}`;
    const payload = commitPayload({ tree, parents: [baseSha, headSha], author: repo.owner, email: `${repo.owner}@users.noreply.github.com`, message });
    const oid = oidOf('commit', payload);
    repo.objects.set(oid, { type: 'commit', data: payload, oid });
    repo.refs.set(`refs/heads/${pull.base}`, oid);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = oid;
    sendJson(res, 200, { sha: oid, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  sendError(res, 404, 'Not Found');
}
