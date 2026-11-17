// The forge's store: users, repositories, git objects, refs, issues, labels, comments and pulls, all
// in memory. Every surface (git smart HTTP, REST, GraphQL, MCP) reads from here, which is what keeps
// the four views of the same data consistent. Nothing time-dependent lives in here: two runs over the
// same seed build byte-identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** A git object as it is stored: type, raw payload and the oid computed from it. */
export interface GitObject {
  readonly type: 'blob' | 'tree' | 'commit' | 'tag';
  readonly data: Buffer;
  readonly oid: string;
}

/** One entry of a git tree, in git's own sort order. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface Label {
  readonly name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly user: string;
  readonly createdAt: string;
  /** Bumped whenever any field above changes, so a serialised body can be cached safely. */
  rev: number;
  /** The last serialised REST body for this issue, with the `rev` and `base` it was made for. */
  cached: { readonly text: string; readonly rev: number; readonly base: string } | null;
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly user: string;
  readonly issueNumber: number;
  readonly createdAt: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly head: string;
  readonly base: string;
  readonly user: string;
  readonly createdAt: string;
  mergeCommitSha: string | null;
  baseShaAtCreate: string | null;
  headShaAtCreate: string | null;
}

/** A repository and everything hanging off it. */
export class Repository {
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly createdAt: string;
  defaultBranch = 'main';

  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly tree = new Map<string, Map<string, string>>();
  readonly issues = new Map<number, Issue>();
  readonly issueComments = new Map<number, Comment[]>();
  readonly pulls = new Map<number, PullRequest>();
  readonly pullComments = new Map<number, Comment[]>();
  readonly labels = new Map<string, Label>();

  issueCounter = 1;
  commentCounter = 1;
  pullCounter = 1;

  constructor(owner: string, name: string, opts: { description?: string; private?: boolean; createdAt?: string } = {}) {
    this.owner = owner;
    this.name = name;
    this.description = opts.description ?? '';
    this.private = opts.private ?? false;
    this.createdAt = opts.createdAt ?? '2024-01-01T00:00:00Z';
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get isPrivate(): boolean {
    return this.private;
  }

  /** The GitHub-shaped REST body for this repository. */
  toJson(base: string): Record<string, unknown> {
    return {
      id: idOf(this.fullName),
      node_id: `R_${idOf(this.fullName)}`,
      name: this.name,
      full_name: this.fullName,
      private: this.private,
      owner: userJson(this.owner),
      html_url: `${base}/${this.fullName}`,
      description: this.description || null,
      fork: false,
      url: `${base}/api/v3/repos/${this.fullName}`,
      created_at: this.createdAt,
      updated_at: this.createdAt,
      pushed_at: this.createdAt,
      homepage: null,
      size: this.objects.size,
      stargazers_count: 0,
      watchers_count: 0,
      language: 'TypeScript',
      forks_count: 0,
      open_issues_count: this.openIssueCount(),
      default_branch: this.defaultBranch,
      visibility: this.private ? 'private' : 'public',
      clone_url: `${base}/${this.fullName}.git`,
      git_url: `git://${hostOf(base)}/${this.fullName}.git`,
      ssh_url: `git@${hostOf(base)}:${this.fullName}.git`,
      svn_url: `${base}/${this.fullName}`,
      has_issues: true,
      has_wiki: false,
      archived: false,
      disabled: false,
    };
  }

  openIssueCount(): number {
    let n = 0;
    for (const issue of this.issues.values()) if (issue.state === 'open') n += 1;
    for (const pull of this.pulls.values()) if (pull.state === 'open') n += 1;
    return n;
  }
}

/** A stable small integer from a string: GitHub's numeric ids, without a counter. */
export function idOf(text: string): number {
  const digest = createHash('sha1').update(text).digest();
  return digest.readUInt32BE(0) % 2_000_000_000 + 1;
}

export function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return 'entry';
  }
}

/** The GitHub user body for a login. */
export function userJson(login: string): Record<string, unknown> {
  const id = idOf(login);
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

// ------------------------------------------------------------------ git objects

/** The oid of an object built from `type` and `data`, computed the way git computes it. */
export function oidOf(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

/** The loose-object form git stores and zlib-deflates: the header, then the payload. */
export function looseObject(type: string, data: Buffer): Buffer {
  return deflateSync(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]));
}

/** A tree payload from its sorted entries. */
export function treePayload(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A commit payload. Git wants the exact shape: tree, parent(s), author, committer, a blank line, message. */
export function commitPayload(opts: {
  tree: string;
  parents: readonly string[];
  author: string;
  email: string;
  message: string;
  time?: number;
  tz?: string;
}): Buffer {
  const time = opts.time ?? 1_700_000_000;
  const tz = opts.tz ?? '+0000';
  const lines = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author} <${opts.email}> ${time} ${tz}`);
  lines.push(`committer ${opts.author} <${opts.email}> ${time} ${tz}`);
  lines.push('');
  lines.push(opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`);
  return Buffer.from(lines.join('\n'));
}

/** Parse a tree payload back into its entries, for the REST contents API. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space);
    if (nul === -1) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Parse a commit payload into the fields the REST and GraphQL views report. */
export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: { name: string; email: string; time: number; tz: string };
  committer: { name: string; email: string; time: number; tz: string };
  message: string;
} {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const lines = header.split('\n');
  const field = (prefix: string): string => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length) : '';
  };
  const parents: string[] = [];
  for (const line of lines) if (line.startsWith('parent ')) parents.push(line.slice(7));
  const person = (line: string): { name: string; email: string; time: number; tz: string } => {
    const match = /^(.*?) <(.*?)> (\d+) (.*)$/.exec(line);
    if (!match) return { name: '', email: '', time: 0, tz: '+0000' };
    return { name: match[1], email: match[2], time: Number(match[3]), tz: match[4] };
  };
  return {
    tree: field('tree '),
    parents,
    author: person(field('author ')),
    committer: person(field('committer ')),
    message,
  };
}

/** Inflate a loose object buffer back to `{ type, data }`, for the pack writer. */
export function inflateLoose(buffer: Buffer): { type: string; data: Buffer } {
  const raw = inflateSync(buffer);
  const nul = raw.indexOf(0x00);
  const header = raw.toString('utf8', 0, nul);
  const space = header.indexOf(' ');
  return { type: header.slice(0, space), data: raw.subarray(nul + 1) };
}
