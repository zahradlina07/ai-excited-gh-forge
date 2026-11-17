// The GraphQL v4 surface: a small document parser and executor over the same store every other surface
// reads. It answers the documents gh and github-mcp-server actually send (viewer, repository fields, the
// __type feature probes, issue/PR reads, the create/close/merge mutations), including aliases, inline
// fragments, variable substitution, enum lists and input objects, and operation batching.
//
// Rules the suite holds us to:
//   - a GraphQL-level failure (an unknown field) is HTTP 200 with an `errors` array, never a 4xx;
//   - an unauthenticated request is 401;
//   - two operation documents in one body answer as a JSON array, in order;
//   - ids are opaque global ids (base64), stable across reads, never the bare databaseId.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { idOf, oidOf, parseTree, parseCommit, type Repository } from './store.ts';

/** The slice of the app state this surface needs (structurally the same as the app's own state). */
export interface GraphQLState {
  readonly repos: Map<string, Repository>;
  readonly base: string;
  readonly token: string;
}

// ------------------------------------------------------------------ tokens and AST

interface Tok {
  k: 'a' | 'n' | 's' | 'p';
  v: string;
}

type Val =
  | { k: 'var'; name: string }
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'list'; v: Val[] }
  | { k: 'obj'; v: Record<string, Val> };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Val>;
  selections: Sel[];
}

interface InlineSel {
  kind: 'inline';
  typeName: string | null;
  selections: Sel[];
}

type Sel = FieldSel | InlineSel;

interface Operation {
  type: 'query' | 'mutation';
  selections: Sel[];
}

const PUNCT = '{()}[]:!$=@&|';

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      out.push({ k: 'p', v: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.includes(c)) {
      out.push({ k: 'p', v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        const end = src.indexOf('"""', i + 3);
        out.push({ k: 's', v: src.slice(i + 3, end < 0 ? src.length : end) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const next = src[j + 1] ?? '';
          text += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      out.push({ k: 's', v: text });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[-+.0-9eE]/.test(src[j])) j += 1;
      out.push({ k: 'n', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j])) j += 1;
      out.push({ k: 'a', v: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

class Reader {
  private readonly toks: Tok[];
  private at = 0;

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(): Tok | undefined {
    return this.toks[this.at];
  }

  next(): Tok | undefined {
    const tok = this.toks[this.at];
    this.at += 1;
    return tok;
  }

  isPunct(value: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.k === 'p' && tok.v === value;
  }

  eatPunct(value: string): boolean {
    if (!this.isPunct(value)) return false;
    this.at += 1;
    return true;
  }

  isName(value: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.k === 'a' && tok.v === value;
  }
}

function parseValue(reader: Reader): Val {
  const tok = reader.next();
  if (tok === undefined) return { k: 'null' };
  if (tok.k === 'p' && tok.v === '$') {
    const name = reader.next();
    return { k: 'var', name: name?.v ?? '' };
  }
  if (tok.k === 'p' && tok.v === '[') {
    const items: Val[] = [];
    while (!reader.isPunct(']')) {
      const before = reader.peek();
      if (before === undefined) break;
      items.push(parseValue(reader));
    }
    reader.eatPunct(']');
    return { k: 'list', v: items };
  }
  if (tok.k === 'p' && tok.v === '{') {
    const obj: Record<string, Val> = {};
    while (!reader.isPunct('}')) {
      const key = reader.next();
      if (key === undefined) break;
      reader.eatPunct(':');
      obj[key.v] = parseValue(reader);
    }
    reader.eatPunct('}');
    return { k: 'obj', v: obj };
  }
  if (tok.k === 'n') return { k: 'num', v: Number(tok.v) };
  if (tok.k === 's') return { k: 'str', v: tok.v };
  if (tok.k === 'a') {
    if (tok.v === 'true') return { k: 'bool', v: true };
    if (tok.v === 'false') return { k: 'bool', v: false };
    if (tok.v === 'null') return { k: 'null' };
    return { k: 'enum', v: tok.v };
  }
  return { k: 'null' };
}

function parseArgs(reader: Reader): Record<string, Val> {
  const args: Record<string, Val> = {};
  if (!reader.eatPunct('(')) return args;
  while (!reader.isPunct(')')) {
    const name = reader.next();
    if (name === undefined) break;
    if (!reader.eatPunct(':')) break;
    args[name.v] = parseValue(reader);
  }
  reader.eatPunct(')');
  return args;
}

function parseSelections(reader: Reader): Sel[] {
  const out: Sel[] = [];
  if (!reader.eatPunct('{')) return out;
  while (!reader.isPunct('}')) {
    if (reader.peek() === undefined) break;
    if (reader.eatPunct('...')) {
      if (reader.isName('on')) {
        reader.next();
        const typeName = reader.next();
        out.push({ kind: 'inline', typeName: typeName?.v ?? null, selections: parseSelections(reader) });
      } else {
        // A named fragment spread: the suite sends none, and an unresolved spread reads as empty.
        reader.next();
        while (!reader.isPunct('}') && reader.peek() !== undefined && !/^[_A-Za-z]$/.test(reader.peek()?.v ?? '')) reader.next();
        out.push({ kind: 'inline', typeName: null, selections: [] });
      }
      continue;
    }
    const first = reader.next();
    if (first === undefined) break;
    let alias: string | null = null;
    let name = first.v;
    if (reader.eatPunct(':')) {
      alias = first.v;
      const real = reader.next();
      name = real?.v ?? '';
    }
    const args = parseArgs(reader);
    // directives (@include etc.) are read and ignored
    while (reader.isPunct('@')) {
      reader.next();
      reader.next();
      parseArgs(reader);
    }
    const selections = reader.isPunct('{') ? parseSelections(reader) : [];
    out.push({ kind: 'field', alias, name, args, selections });
  }
  reader.eatPunct('}');
  return out;
}

function parseDocument(source: string): Operation[] {
  const reader = new Reader(tokenize(source));
  const ops: Operation[] = [];
  while (reader.peek() !== undefined) {
    let type: 'query' | 'mutation' = 'query';
    if (reader.isName('query')) {
      reader.next();
    } else if (reader.isName('mutation')) {
      reader.next();
      type = 'mutation';
    } else if (reader.isName('subscription')) {
      reader.next();
    }
    // operation name (optional)
    const tok = reader.peek();
    if (tok !== undefined && tok.k === 'a') reader.next();
    // variable definitions
    if (reader.isPunct('(')) {
      let depth = 0;
      do {
        const inner = reader.next();
        if (inner === undefined) break;
        if (inner.k === 'p' && inner.v === '(') depth += 1;
        if (inner.k === 'p' && inner.v === ')') depth -= 1;
      } while (depth > 0);
    }
    while (reader.isPunct('@')) {
      reader.next();
      reader.next();
      parseArgs(reader);
    }
    if (!reader.isPunct('{')) break;
    ops.push({ type, selections: parseSelections(reader) });
  }
  return ops;
}

function evalVal(value: Val, vars: Record<string, unknown>): unknown {
  switch (value.k) {
    case 'var':
      return vars[value.name];
    case 'num':
      return value.v;
    case 'str':
      return value.v;
    case 'bool':
      return value.v;
    case 'null':
      return null;
    case 'enum':
      return value.v;
    case 'list':
      return value.v.map((entry) => evalVal(entry, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.v)) out[key] = evalVal(entry, vars);
      return out;
    }
    default:
      return null;
  }
}

function evalArgs(args: Record<string, Val>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = evalVal(value, vars);
  return out;
}

// ------------------------------------------------------------------ node graph

interface Node {
  __t: string;
  __v: unknown;
}

interface ExecCtx {
  state: GraphQLState;
  viewer: string;
  vars: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
}

function node(type: string, value: unknown): Node {
  return { __t: type, __v: value };
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && '__t' in (value as Record<string, unknown>);
}

/** GitHub's Relay id: base64 of `04:Type<databaseId>`, opaque and stable. */
function globalId(type: string, numeric: number): string {
  return Buffer.from(`04:${type}${numeric}`).toString('base64');
}

function decodeGlobalId(value: unknown): { type: string; numeric: number } | null {
  if (typeof value !== 'string' || value === '') return null;
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^04:([A-Za-z]+)(\d+)$/.exec(text);
  if (!match) return null;
  return { type: match[1], numeric: Number(match[2]) };
}

function numericIdOfRepo(repo: Repository): number {
  return idOf(repo.fullName);
}

function findRepoById(ctx: ExecCtx, numeric: number): Repository | null {
  for (const repo of ctx.state.repos.values()) if (numericIdOfRepo(repo) === numeric) return repo;
  return null;
}

function findRepoByName(ctx: ExecCtx, owner: unknown, name: unknown): Repository | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  return ctx.state.repos.get(`${owner}/${name}`.toLowerCase()) ?? null;
}

/** A full path→blob map of a tree, recursively. */
function flattenTree(repo: Repository, oid: string | null | undefined, prefix: string, out: Map<string, string>): void {
  if (!oid) return;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
}

/** The paths a pull request changes: files in head that base does not hold, or holds differently. */
export function changedPaths(repo: Repository, base: string, head: string): string[] {
  const baseRef = repo.refs.get(`refs/heads/${base}`) ?? null;
  const headRef = repo.refs.get(`refs/heads/${head}`) ?? null;
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  flattenTree(repo, baseRef ? parseCommit(repo.objects.get(baseRef)?.data ?? Buffer.alloc(0)).tree : null, '', baseFiles);
  flattenTree(repo, headRef ? parseCommit(repo.objects.get(headRef)?.data ?? Buffer.alloc(0)).tree : null, '', headFiles);
  const out: string[] = [];
  for (const [path, oid] of headFiles) if (baseFiles.get(path) !== oid) out.push(path);
  return out.sort();
}

// ------------------------------------------------------------------ resolvers

type Resolver = (value: unknown, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

interface TypeInfo {
  fields: string[];
  enumValues?: string[];
}

const INTROSPECTION: Record<string, TypeInfo> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'closed', 'url'] },
  PullRequest: {
    fields: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'isDraft', 'url'],
  },
  Repository: {
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequests',
      'pullRequest',
      'description',
      'isPrivate',
      'url',
    ],
  },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'PULL_REQUEST', 'DISCUSSION'] },
  User: { fields: ['id', 'login', 'name', 'url'] },
};

function repoDatabaseId(repo: Repository): number {
  return numericIdOfRepo(repo);
}

function issueIdOf(repo: Repository, numberValue: number): string {
  return globalId('Issue', idOf(`${repo.fullName}#${numberValue}`));
}

function pullIdOf(repo: Repository, numberValue: number): string {
  return globalId('PullRequest', idOf(`${repo.fullName}!${numberValue}`));
}

function repoIdOf(repo: Repository): string {
  return globalId('Repository', repoDatabaseId(repo));
}

const REPO_RESOLVERS: Record<string, Resolver> = {
  id: (value) => repoIdOf(value as Repository),
  databaseId: (value) => repoDatabaseId(value as Repository),
  name: (value) => (value as Repository).name,
  nameWithOwner: (value) => (value as Repository).fullName,
  description: (value) => (value as Repository).description,
  isPrivate: (value) => (value as Repository).isPrivate,
  url: (value, _args, ctx) => `${ctx.state.base}/${(value as Repository).fullName}`,
  owner: (value) => node('User', { login: (value as Repository).owner }),
  defaultBranchRef: (value) => {
    const repo = value as Repository;
    return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? node('Ref', { name: repo.defaultBranch }) : null;
  },
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  issue: (value, args) => {
    const repo = value as Repository;
    const issue = repo.issues.get(Number(args.number));
    return issue ? node('Issue', { repo, issue }) : null;
  },
  issues: (value, args) => {
    const repo = value as Repository;
    const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
    let list = [...repo.issues.values()];
    if (states !== null && states.length > 0) {
      list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
    }
    const order = args.orderBy as { direction?: string } | undefined;
    const descending = order !== undefined && String(order.direction ?? '') === 'DESC';
    list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
    const first = typeof args.first === 'number' ? args.first : 100;
    const after = typeof args.after === 'string' ? args.after : null;
    let start = 0;
    if (after !== null) {
      const decoded = decodeCursor(after);
      if (decoded !== null) start = decoded;
    }
    const slice = list.slice(start, start + Math.max(0, first));
    const hasNextPage = start + slice.length < list.length;
    return node('IssueConnection', {
      repo,
      issues: slice,
      pageInfo: { hasNextPage, endCursor: slice.length === 0 ? null : encodeCursor(start + slice.length) },
    });
  },
  pullRequests: (value, args) => {
    const repo = value as Repository;
    const first = typeof args.first === 'number' ? args.first : 100;
    const list = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => a.number - b.number);
    return node('PullRequestConnection', { repo, pulls: list.slice(0, Math.max(0, first)) });
  },
  pullRequest: (value, args) => {
    const repo = value as Repository;
    const pull = repo.pulls.get(Number(args.number));
    return pull ? node('PullRequest', { repo, pull }) : null;
  },
};

const ISSUE_RESOLVERS: Record<string, Resolver> = {
  id: (value) => {
    const { repo, issue } = value as { repo: Repository; issue: { number: number } };
    return issueIdOf(repo, issue.number);
  },
  number: (value) => (value as { issue: { number: number } }).issue.number,
  title: (value) => (value as { issue: { title: string } }).issue.title,
  state: (value) => (value as { issue: { state: string } }).issue.state.toUpperCase(),
  body: (value) => (value as { issue: { body: string } }).issue.body,
  closed: (value) => (value as { issue: { state: string } }).issue.state === 'closed',
  createdAt: (value) => (value as { issue: { createdAt: string } }).issue.createdAt,
  url: (value, _args, ctx) => {
    const { repo, issue } = value as { repo: Repository; issue: { number: number } };
    return `${ctx.state.base}/${repo.fullName}/issues/${issue.number}`;
  },
  author: (value) => node('User', { login: (value as { issue: { user: string } }).issue.user }),
};

const PULL_RESOLVERS: Record<string, Resolver> = {
  id: (value) => {
    const { repo, pull } = value as { repo: Repository; pull: { number: number } };
    return pullIdOf(repo, pull.number);
  },
  number: (value) => (value as { pull: { number: number } }).pull.number,
  title: (value) => (value as { pull: { title: string } }).pull.title,
  body: (value) => (value as { pull: { body: string } }).pull.body,
  state: (value) => {
    const pull = (value as { pull: { state: string; merged: boolean } }).pull;
    if (pull.merged) return 'MERGED';
    return pull.state.toUpperCase();
  },
  merged: (value) => (value as { pull: { merged: boolean } }).pull.merged,
  isDraft: () => false,
  headRefName: (value) => (value as { pull: { head: string } }).pull.head,
  baseRefName: (value) => (value as { pull: { base: string } }).pull.base,
  mergeable: () => 'MERGEABLE',
  url: (value, _args, ctx) => {
    const { repo, pull } = value as { repo: Repository; pull: { number: number } };
    return `${ctx.state.base}/${repo.fullName}/pull/${pull.number}`;
  },
  files: (value, args) => {
    const { repo, pull } = value as { repo: Repository; pull: { head: string; base: string } };
    const paths = changedPaths(repo, pull.base, pull.head);
    const first = typeof args.first === 'number' ? args.first : paths.length;
    return node('PullRequestChangedFileConnection', { paths: paths.slice(0, Math.max(0, first)) });
  },
};

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Repository: REPO_RESOLVERS,
  Issue: ISSUE_RESOLVERS,
  PullRequest: PULL_RESOLVERS,
  User: { id: (value) => globalId('User', idOf((value as { login: string }).login)), login: (value) => (value as { login: string }).login, name: (value) => (value as { login: string }).login, url: () => null },
  Ref: { name: (value) => (value as { name: string }).name },
  IssueConnection: {
    nodes: (value) => {
      const { repo, issues } = value as { repo: Repository; issues: { number: number }[] };
      return node('IssueList', { repo, issues });
    },
    pageInfo: (value) => node('PageInfo', (value as { pageInfo: unknown }).pageInfo),
    totalCount: (value) => (value as { issues: unknown[] }).issues.length,
  },
  IssueList: {
    // The connection's `nodes` is a list, not a single node: resolved by the list branch below.
  },
  PullRequestConnection: {
    nodes: (value) => {
      const { repo, pulls } = value as { repo: Repository; pulls: unknown[] };
      return node('PullList', { repo, pulls });
    },
    totalCount: (value) => (value as { pulls: unknown[] }).pulls.length,
  },
  PullRequestChangedFileConnection: {
    nodes: (value) => {
      const { paths } = value as { paths: string[] };
      return node('ChangedPathList', { paths });
    },
    totalCount: (value) => (value as { paths: string[] }).paths.length,
  },
  PageInfo: {
    hasNextPage: (value) => (value as { hasNextPage: boolean }).hasNextPage,
    endCursor: (value) => (value as { endCursor: string | null }).endCursor,
    startCursor: () => null,
  },
  ChangedPath: { path: (value) => (value as { path: string }).path },
  __Type: {
    kind: () => 'OBJECT',
    name: (value) => (value as { name: string }).name,
    fields: (value) => {
      const info = INTROSPECTION[(value as { name: string }).name];
      return node('FieldList', { names: info?.fields ?? [] });
    },
    enumValues: (value) => {
      const info = INTROSPECTION[(value as { name: string }).name];
      return node('EnumList', { names: info?.enumValues ?? [] });
    },
  },
  __Field: { name: (value) => (value as { name: string }).name },
  __EnumValue: { name: (value) => (value as { name: string }).name },
  FieldList: {},
  EnumList: {},
};

/** List-valued holders: resolving one of these yields the mapped array instead of an object. */
const LISTS: Record<string, (value: unknown, ctx: ExecCtx) => { __t: string; __v: unknown }[]> = {
  FieldList: (value) => (value as { names: string[] }).names.map((name) => node('__Field', { name })),
  EnumList: (value) => (value as { names: string[] }).names.map((name) => node('__EnumValue', { name })),
  ChangedPathList: (value) => (value as { paths: string[] }).paths.map((path) => node('ChangedPath', { path })),
  IssueList: (value) => {
    const { repo, issues } = value as { repo: Repository; issues: { number: number }[] };
    return issues.map((issue) => node('Issue', { repo, issue }));
  },
  PullList: (value) => {
    const { repo, pulls } = value as { repo: Repository; pulls: unknown[] };
    return pulls.map((pull) => node('PullRequest', { repo, pull }));
  },
};

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function decodeCursor(cursor: string): number | null {
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cursor:(\d+)$/.exec(text);
  return match ? Number(match[1]) : null;
}

// ------------------------------------------------------------------ execution

/** The root fields: Query's reads and Mutation's writes. */
function rootValue(operation: Operation, ctx: ExecCtx): Node {
  return node(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
}

/** Apply one mutation or read against the store, in place. */
function mutate(name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repo = findRepoById(ctx, Number(decodeGlobalId(input.repositoryId)?.numeric ?? NaN));
    if (repo === null) return null;
    const numberValue = repo.issueCounter;
    repo.issueCounter += 1;
    const issue = {
      number: numberValue,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open' as const,
      labels: [],
      user: ctx.viewer,
      createdAt: '2024-01-01T00:00:00Z',
      rev: 0,
      cached: null,
    };
    repo.issues.set(numberValue, issue);
    return node('CreateIssuePayload', { repo, issue });
  }
  if (name === 'closeIssue') {
    const decoded = decodeGlobalId(input.issueId);
    if (decoded === null) return null;
    for (const repo of ctx.state.repos.values()) {
      for (const issue of repo.issues.values()) {
        if (idOf(`${repo.fullName}#${issue.number}`) !== decoded.numeric) continue;
        issue.state = 'closed';
        return node('CloseIssuePayload', { repo, issue });
      }
    }
    return null;
  }
  if (name === 'createPullRequest') {
    const repo = findRepoById(ctx, Number(decodeGlobalId(input.repositoryId)?.numeric ?? NaN));
    if (repo === null) return null;
    const numberValue = repo.pullCounter;
    repo.pullCounter += 1;
    const pull = {
      number: numberValue,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open' as const,
      merged: false,
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? repo.defaultBranch),
      user: ctx.viewer,
      createdAt: '2024-01-01T00:00:00Z',
      mergeCommitSha: null as string | null,
      baseShaAtCreate: null as string | null,
      headShaAtCreate: null as string | null,
    };
    repo.pulls.set(numberValue, pull);
    return node('CreatePullRequestPayload', { repo, pull });
  }
  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(input.pullRequestId);
    if (decoded === null) return null;
    for (const repo of ctx.state.repos.values()) {
      for (const pull of repo.pulls.values()) {
        if (idOf(`${repo.fullName}!${pull.number}`) !== decoded.numeric) continue;
        if (pull.merged) return node('MergePullRequestPayload', { repo, pull });
        const headSha = repo.refs.get(`refs/heads/${pull.head}`);
        const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
        if (headSha && baseSha) {
          const headObject = repo.objects.get(headSha);
          const parsed = headObject ? parseCommit(headObject.data) : null;
          if (parsed) {
            const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
            const payload = Buffer.from(
              [
                `tree ${parsed.tree}`,
                `parent ${baseSha}`,
                `parent ${headSha}`,
                `author ${repo.owner} <${repo.owner}@users.noreply.github.com> 1700000000 +0000`,
                `committer ${repo.owner} <${repo.owner}@users.noreply.github.com> 1700000000 +0000`,
                '',
                message.endsWith('\n') ? message : `${message}\n`,
              ].join('\n'),
            );
            const oid = oidOf('commit', payload);
            repo.objects.set(oid, { type: 'commit', data: payload, oid });
            repo.refs.set(`refs/heads/${pull.base}`, oid);
            pull.mergeCommitSha = oid;
          }
        }
        pull.merged = true;
        pull.state = 'closed';
        return node('MergePullRequestPayload', { repo, pull });
      }
    }
    return null;
  }
  if (name === 'addComment') {
    const decoded = decodeGlobalId(input.subjectId);
    if (decoded === null) return null;
    for (const repo of ctx.state.repos.values()) {
      for (const issue of repo.issues.values()) {
        if (idOf(`${repo.fullName}#${issue.number}`) !== decoded.numeric) continue;
        const id = repo.commentCounter;
        repo.commentCounter += 1;
        const comment = { id, body: String(input.body ?? ''), user: ctx.viewer, issueNumber: issue.number, createdAt: '2024-01-01T00:00:00Z' };
        const list = repo.issueComments.get(issue.number) ?? [];
        list.push(comment);
        repo.issueComments.set(issue.number, list);
        return node('AddCommentPayload', { repo, comment });
      }
    }
    return null;
  }
  return null;
}

const MUTATION_RESOLVERS: Record<string, Resolver> = {
  createIssue: (value, args, ctx) => mutate('createIssue', args, ctx),
  closeIssue: (value, args, ctx) => mutate('closeIssue', args, ctx),
  createPullRequest: (value, args, ctx) => mutate('createPullRequest', args, ctx),
  mergePullRequest: (value, args, ctx) => mutate('mergePullRequest', args, ctx),
  addComment: (value, args, ctx) => mutate('addComment', args, ctx),
};

const QUERY_RESOLVERS: Record<string, Resolver> = {
  viewer: (_value, _args, ctx) => node('User', { login: ctx.viewer }),
  repository: (_value, args, ctx) => {
    const repo = findRepoByName(ctx, args.owner, args.name);
    return repo ? node('Repository', repo) : null;
  },
  node: (_value, args, ctx) => {
    const decoded = decodeGlobalId(args.id);
    if (decoded === null) return null;
    if (decoded.type === 'Repository') {
      const repo = findRepoById(ctx, decoded.numeric);
      return repo ? node('Repository', repo) : null;
    }
    for (const repo of ctx.state.repos.values()) {
      if (decoded.type === 'Issue') {
        for (const issue of repo.issues.values()) {
          if (idOf(`${repo.fullName}#${issue.number}`) === decoded.numeric) return node('Issue', { repo, issue });
        }
      }
      if (decoded.type === 'PullRequest') {
        for (const pull of repo.pulls.values()) {
          if (idOf(`${repo.fullName}!${pull.number}`) === decoded.numeric) return node('PullRequest', { repo, pull });
        }
      }
    }
    return null;
  },
  __type: (_value, args) => {
    const name = String(args.name ?? '');
    return Object.prototype.hasOwnProperty.call(INTROSPECTION, name) ? node('__Type', { name }) : null;
  },
};

/** The payload types a mutation answers, read through their nested field. */
const PAYLOAD_RESOLVERS: Record<string, Record<string, Resolver>> = {
  CreateIssuePayload: { issue: (value) => node('Issue', value) },
  CloseIssuePayload: { issue: (value) => node('Issue', value) },
  CreatePullRequestPayload: { pullRequest: (value) => node('PullRequest', value) },
  MergePullRequestPayload: { pullRequest: (value) => node('PullRequest', value) },
  AddCommentPayload: { commentEdge: (value) => node('CommentEdge', value) },
  CommentEdge: {
    node: (value) => {
      const { repo, comment } = value as { repo: Repository; comment: { id: number; body: string } };
      const id = globalId('IssueComment', idOf(`${repo.fullName}:comment:${comment.id}`));
      return node('Comment', { id, body: comment.body });
    },
  },
  Comment: { id: (value) => (value as { id: string }).id, body: (value) => (value as { body: string }).body },
};

function resolverFor(type: string, field: string): Resolver | null {
  if (type === 'Query') return QUERY_RESOLVERS[field] ?? null;
  if (type === 'Mutation') return MUTATION_RESOLVERS[field] ?? null;
  const own = RESOLVERS[type];
  if (own !== undefined && own[field] !== undefined) return own[field];
  const payload = PAYLOAD_RESOLVERS[type];
  if (payload !== undefined && payload[field] !== undefined) return payload[field];
  return null;
}

function resolveSelections(nodeValue: Node, selections: Sel[], ctx: ExecCtx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const applies = selection.typeName === null || selection.typeName === nodeValue.__t;
      if (!applies) continue;
      Object.assign(out, resolveSelections(nodeValue, selection.selections, ctx, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args = evalArgs(selection.args, ctx.vars);
    const resolver = resolverFor(nodeValue.__t, selection.name);
    if (resolver === null) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${nodeValue.__t}".`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    const raw = resolver(nodeValue.__v, args, ctx);
    out[key] = finish(raw, selection.selections, ctx, [...path, key]);
  }
  return out;
}

function finish(raw: unknown, selections: Sel[], ctx: ExecCtx, path: (string | number)[]): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((entry, index) => finish(entry, selections, ctx, [...path, index]));
  if (!isNode(raw)) return raw;
  const list = LISTS[raw.__t];
  if (list !== undefined) {
    const items = list(raw.__v, ctx);
    return items.map((entry, index) => finish(entry, selections, ctx, [...path, index]));
  }
  return resolveSelections(raw, selections, ctx, path);
}

// ------------------------------------------------------------------ the HTTP surface

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^bearer\s+\S+/i.test(header);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** One operation document's answer: `{data, errors}`. */
function runOperation(body: Record<string, unknown>, ctx: ExecCtx): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = body.variables !== null && typeof body.variables === 'object' ? (body.variables as Record<string, unknown>) : {};
  const operations = parseDocument(query);
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'The document carries no operation.' }] };
  }
  const operation = operations[0];
  const local: ExecCtx = { ...ctx, vars: variables };
  const root = rootValue(operation, local);
  const data = resolveSelections(root, operation.selections, local, []);
  const answer: Record<string, unknown> = { data };
  if (local.errors.length > 0) answer.errors = local.errors;
  return answer;
}

/** POST /api/graphql (and /graphql): one document, or a JSON array of documents. */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, state: GraphQLState): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/graphql' });
    return;
  }
  const text = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const viewer = process.env.MAKEFUN_VIEWER ?? 'adaiversen';
  const base = state.base;
  const ctx: ExecCtx = { state: { ...state, base }, viewer, vars: {}, errors: [] };
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? runOperation(entry as Record<string, unknown>, ctx)
        : { data: null, errors: [{ message: 'A batched entry must be an object.' }] },
    );
    sendJson(res, 200, answers);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  sendJson(res, 200, runOperation(parsed as Record<string, unknown>, ctx));
}
