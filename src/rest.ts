// The REST v3 surface: repositories, branches, commits, contents, issues, comments, labels, pulls and
// merges. Everything reads from the store, so a git push and an issue write are visible to every other
// surface at once. Status codes and bodies follow api.github.com closely, because the suite checks them
// as tightly as the data.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Repository,
  type Comment,
  type Issue,
  type PullRequest,
  commitPayload,
  idOf,
  oidOf,
  parseCommit,
  parseTree,
  treePayload,
  userJson,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** What one REST request needs: the store, the base url and the caller. */
export interface RestContext {
  readonly repos: Map<string, Repository>;
  readonly base: string;
  readonly user: string;
  readonly token: string;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-media-type': 'github.v3',
    ...headers,
  });
  res.end(text);
}

/** GitHub's error body. */
export function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest', ...extra });
}

/** Read and parse a JSON request body; an empty body is `{}`. A body that is not JSON marks itself. */
export const MALFORMED = '__malformed_json__';

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { [MALFORMED]: true };
  }
}

/** Whether a parsed body came from text that was not JSON at all. */
export function isMalformed(body: Record<string, unknown>): boolean {
  return body[MALFORMED] === true;
}

/** Splits a path into its decoded segments, dropping empty ones. */
export function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
}

/** The `?page=&per_page=` window and the headers GitHub sends with it. */
export function paginate<T>(items: readonly T[], url: URL): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const headers: Record<string, string> = {
    link: buildLink(url, page, lastPage, perPage),
    'x-total-count': String(items.length),
  };
  return { page: slice, headers };
}

function buildLink(url: URL, page: number, lastPage: number, perPage: number): string {
  const origin = `${url.protocol}//${url.host}${url.pathname}`;
  const link = (n: number, rel: string): string => `<${origin}?page=${n}&per_page=${perPage}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < lastPage) parts.push(link(page + 1, 'next'), link(lastPage, 'last'));
  if (page > 1) parts.push(link(page - 1, 'prev'), link(1, 'first'));
  return parts.join(', ');
}

/** The `{owner}/{repo}` a path names, or null. */
export function repoNames(parts: readonly string[]): { owner: string; name: string } | null {
  if (parts.length < 3) return null;
  return { owner: parts[1], name: parts[2].replace(/\.git$/, '') };
}

// ------------------------------------------------------------------ serialisers

export function issueJson(repo: Repository, issue: Issue, base: string): Record<string, unknown> {
  return {
    id: idOf(`${repo.fullName}#${issue.number}`),
    node_id: `I_${idOf(`${repo.fullName}#${issue.number}`)}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: idOf(`${repo.fullName}:${name}`), name, color: label?.color ?? 'ededed', description: label?.description ?? null };
    }),
    comments: (repo.issueComments.get(issue.number) ?? []).length,
    locked: false,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    closed_at: null,
    html_url: `${base}/${repo.fullName}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.fullName}`,
  };
}

export function commentJson(repo: Repository, comment: Comment, base: string, kind: 'issues' | 'pulls'): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: `${base}/api/v3/repos/${repo.fullName}/${kind}/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repository, pull: PullRequest, base: string): Record<string, unknown> {
  const id = idOf(`${repo.fullName}!${pull.number}`);
  return {
    id,
    node_id: `PR_${id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userJson(pull.user),
    labels: [],
    draft: false,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    merged_at: pull.merged ? pull.createdAt : null,
    comments: (repo.pullComments.get(pull.number) ?? []).length,
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: repo.refs.get(`refs/heads/${pull.head}`) ?? pull.base },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: repo.refs.get(`refs/heads/${pull.base}`) ?? pull.base },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    closed_at: null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at_sha: pull.mergeCommitSha,
    html_url: `${base}/${repo.fullName}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

export function commitJson(repo: Repository, sha: string, base: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const message = parsed.message.replace(/\n$/, '');
  const url = `${base}/api/v3/repos/${repo.fullName}/commits/${sha}`;
  return {
    sha,
    node_id: `C_${sha}`,
    url,
    html_url: `${base}/${repo.fullName}/commit/${sha}`,
    author: { ...userJson(parsed.author.name || repo.owner), date: isoOf(parsed.author.time) },
    committer: { ...userJson(parsed.committer.name || repo.owner), date: isoOf(parsed.committer.time) },
    message,
    // GitHub nests the raw commit under `commit`; list and detail endpoints both carry it.
    commit: {
      url,
      message,
      author: { name: parsed.author.name || repo.owner, email: `${repo.owner}@users.noreply.github.com`, date: isoOf(parsed.author.time) },
      committer: { name: parsed.committer.name || repo.owner, email: `${repo.owner}@users.noreply.github.com`, date: isoOf(parsed.committer.time) },
      tree: { sha: parsed.tree, url: `${base}/api/v3/repos/${repo.fullName}/git/trees/${parsed.tree}` },
      comment_count: 0,
    },
    tree: { sha: parsed.tree, url: `${base}/api/v3/repos/${repo.fullName}/git/trees/${parsed.tree}` },
    parents: parsed.parents.map((parent) => ({ sha: parent, url: `${base}/api/v3/repos/${repo.fullName}/commits/${parent}` })),
  };
}

export function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The commit shas reachable from a ref, newest first. */
export function history(repo: Repository, sha: string, max = 100): string[] {
  const out: string[] = [];
  let current: string | undefined = sha;
  while (current && out.length < max) {
    if (out.includes(current)) break;
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') break;
    out.push(current);
    current = parseCommit(object.data).parents[0];
  }
  return out;
}

/** Resolve a revision the way the contents API accepts one: a ref name, a branch, or a sha. */
export function resolveRef(repo: Repository, rev: string | null): string | null {
  if (!rev || rev === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(`refs/heads/${rev}`)) return repo.refs.get(`refs/heads/${rev}`) ?? null;
  if (repo.refs.has(`refs/tags/${rev}`)) return repo.refs.get(`refs/tags/${rev}`) ?? null;
  if (repo.refs.has(rev)) return repo.refs.get(rev) ?? null;
  if (repo.objects.has(rev)) return rev;
  return null;
}

/** The tree oid a commit or tree oid points at. */
export function treeOf(repo: Repository, sha: string): string | null {
  const object = repo.objects.get(sha);
  if (!object) return null;
  if (object.type === 'tree') return sha;
  if (object.type === 'commit') return parseCommit(object.data).tree;
  if (object.type === 'tag') {
    const text = object.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    return match ? treeOf(repo, match[1]) : null;
  }
  return null;
}

/** Walk a path from a tree, returning the entry it lands on. */
export function walkPath(repo: Repository, treeOid: string, parts: readonly string[]): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === parts[index]);
    if (!entry) return null;
    if (index === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    current = entry.oid;
  }
  return null;
}

/** The contents-API body for one entry. */
export function contentJson(repo: Repository, base: string, path: string, oid: string, mode: string, ref: string | null): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const isDir = object?.type === 'tree';
  const name = path.split('/').pop() ?? path;
  if (isDir) {
    return {
      type: 'dir',
      size: 0,
      name,
      path,
      sha: oid,
      url: `${base}/api/v3/repos/${repo.fullName}/contents/${path}${ref ? `?ref=${ref}` : ''}`,
      git_url: `${base}/api/v3/repos/${repo.fullName}/git/trees/${oid}`,
      html_url: `${base}/${repo.fullName}/tree/${ref ?? repo.defaultBranch}/${path}`,
      download_url: null,
      _links: { self: `${base}/api/v3/repos/${repo.fullName}/contents/${path}`, git: `${base}/api/v3/repos/${repo.fullName}/git/trees/${oid}`, html: `${base}/${repo.fullName}/tree/${ref ?? repo.defaultBranch}/${path}` },
    };
  }
  return {
    type: 'file',
    encoding: 'base64',
    size: object?.data.length ?? 0,
    name,
    path,
    content: (object?.data ?? Buffer.alloc(0)).toString('base64').replace(/(.{60})/g, '$1\n'),
    sha: oid,
    url: `${base}/api/v3/repos/${repo.fullName}/contents/${path}${ref ? `?ref=${ref}` : ''}`,
    git_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${oid}`,
    html_url: `${base}/${repo.fullName}/blob/${ref ?? repo.defaultBranch}/${path}`,
    download_url: `${base}/${repo.fullName}/raw/${ref ?? repo.defaultBranch}/${path}`,
    _links: { self: `${base}/api/v3/repos/${repo.fullName}/contents/${path}`, git: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${oid}`, html: `${base}/${repo.fullName}/blob/${ref ?? repo.defaultBranch}/${path}` },
  };
}

/** Read a tree object into a name -> entry map; a missing or non-tree oid reads as empty. */
export function readTree(repo: Repository, treeOid: string | null): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const object = treeOid ? repo.objects.get(treeOid) : undefined;
  if (object && object.type === 'tree') {
    for (const entry of parseTree(object.data)) out.set(entry.name, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Write a name -> entry map as a tree object and return its oid. */
function writeTree(repo: Repository, entries: Map<string, { mode: string; oid: string }>): string {
  const buffer = treePayload([...entries.entries()].map(([name, entry]) => ({ mode: entry.mode, name, oid: entry.oid })));
  const oid = oidOf('tree', buffer);
  repo.objects.set(oid, { type: 'tree', data: buffer, oid });
  return oid;
}

/** Every file below a tree, keyed by its slash-joined path. */
export function flattenTree(repo: Repository, treeOid: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string | null, prefix: string): void => {
    for (const [name, entry] of readTree(repo, oid)) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build and store a commit on top of `parent`, merging the named files into the existing tree. */
export function writeCommit(
  repo: Repository,
  opts: { parent: string | null; message: string; author: string; files: Map<string, Buffer> },
): string {
  const root = readTree(repo, opts.parent ? treeOf(repo, opts.parent) : null);
  for (const [path, content] of opts.files) {
    const blobOid = oidOf('blob', content);
    repo.objects.set(blobOid, { type: 'blob', data: content, oid: blobOid });
    const parts = path.split('/');
    // Descend through each directory, keeping the siblings already there, then write every touched
    // tree back on the way up so both new and old entries survive.
    const chain: Map<string, { mode: string; oid: string }>[] = [root];
    for (let index = 0; index < parts.length - 1; index += 1) {
      const parent = chain[chain.length - 1];
      const existing = parent.get(parts[index]);
      const next = readTree(repo, existing && existing.mode === '40000' ? existing.oid : null);
      parent.set(parts[index], { mode: '40000', oid: '' });
      chain.push(next);
    }
    chain[chain.length - 1].set(parts[parts.length - 1], { mode: '100644', oid: blobOid });
    for (let index = chain.length - 1; index > 0; index -= 1) {
      const oid = writeTree(repo, chain[index]);
      chain[index - 1].set(parts[index - 1], { mode: '40000', oid });
    }
  }
  const treeOid = writeTree(repo, root);

  const payload = commitPayload({
    tree: treeOid,
    parents: opts.parent ? [opts.parent] : [],
    author: opts.author,
    email: `${opts.author}@users.noreply.github.com`,
    message: opts.message,
  });
  const sha = oidOf('commit', payload);
  repo.objects.set(sha, { type: 'commit', data: payload, oid: sha });
  return sha;
}
