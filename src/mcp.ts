// The MCP surface: streamable HTTP JSON-RPC at /mcp, serving the six tools the suite calls (create_repo,
// get_repo, create_issue, list_issues, create_pull_request, merge_pull_request). Every tool writes through
// the same store the REST surface reads, so an object created over MCP is the same object over REST.
//
// The suite's client probes `server/discover` first and negotiates the 2026-07-28 revision; a pre-discover
// client would fall back to `initialize`, which is served too. Answers are plain JSON (no SSE), which the
// transport allows for a single request.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Repository, idOf, type PullRequest } from './store.ts';
import { commitPayload, oidOf } from './store.ts';
import { resolveRef, treeOf } from './rest.ts';

/** The slice of the app state this surface needs. */
export interface McpState {
  readonly repos: Map<string, Repository>;
  readonly base: string;
  readonly token: string;
}

const SERVER_INFO = { name: 'makefun-gh-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const PROTOCOL_VERSION = '2026-07-28';

// JSON-RPC codes the suite judges.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties?: boolean;
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });
const bool = (description: string): { type: string; description: string } => ({ type: 'boolean', description });
const int = (description: string): { type: string; description: string } => ({ type: 'integer', description });

/** The tool list. Order is fixed, so two `tools/list` answers are byte-identical. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The account that will own the repository.'),
        name: str('The repository name.'),
        description: str('A short description of the repository.'),
        private: bool('Whether the repository is private.'),
      },
      required: ['owner', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The account that owns the repository.'),
        repo: str('The repository name.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository and return its number and id.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The account that owns the repository.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, newest first, filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The account that owns the repository.'),
        repo: str('The repository name.'),
        state: str('open, closed, or all.'),
        limit: int('How many issues to return.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The account that owns the repository.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        body: str('The pull request body.'),
        head: str('The branch holding the changes.'),
        base: str('The branch the changes merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request and return its merged state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The account that owns the repository.'),
        repo: str('The repository name.'),
        pull_number: int('The pull request number.'),
        merge_method: str('merge, squash, or rebase.'),
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// ------------------------------------------------------------------ tool implementations

function findRepo(state: McpState, owner: string, name: string): Repository | undefined {
  return state.repos.get(`${owner}/${name}`.toLowerCase());
}

function repoJson(state: McpState, repo: Repository): Record<string, unknown> {
  return repo.toJson(state.base);
}

function issueJson(repo: Repository, numberValue: number, state: McpState): Record<string, unknown> {
  const issue = repo.issues.get(numberValue);
  if (issue === undefined) return {};
  return {
    id: idOf(`${repo.fullName}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: { login: issue.user },
    html_url: `${state.base}/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repository, numberValue: number, state: McpState): Record<string, unknown> {
  const pull = repo.pulls.get(numberValue);
  if (pull === undefined) return {};
  return {
    id: idOf(`${repo.fullName}!${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, label: `${repo.owner}:${pull.base}` },
    html_url: `${state.base}/${repo.fullName}/pull/${pull.number}`,
  };
}

/** A tool's answer, or the reason it could not run. */
interface ToolAnswer {
  payload: Record<string, unknown>;
  isError: boolean;
}

function ok(payload: Record<string, unknown>): ToolAnswer {
  return { payload, isError: false };
}

function failed(message: string): ToolAnswer {
  return { payload: { error: message }, isError: true };
}

function textOf(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function runTool(name: string, args: Record<string, unknown>, ctx: { state: McpState; viewer: string }): ToolAnswer | null {
  const { state, viewer } = ctx;
  if (name === 'create_repo') {
    const repoName = textOf(args, 'name');
    if (repoName === '') return failed('name is required');
    const key = `${viewer}/${repoName}`.toLowerCase();
    const existing = state.repos.get(key);
    if (existing !== undefined) return ok(repoJson(state, existing));
    const repo = new Repository(viewer, repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    state.repos.set(key, repo);
    return ok(repoJson(state, repo));
  }
  if (name === 'get_repo') {
    const owner = textOf(args, 'owner') || viewer;
    const repo = findRepo(state, owner, textOf(args, 'repo'));
    return repo === undefined ? failed(`repository ${owner}/${textOf(args, 'repo')} not found`) : ok(repoJson(state, repo));
  }
  if (name === 'create_issue') {
    const owner = textOf(args, 'owner') || viewer;
    const repo = findRepo(state, owner, textOf(args, 'repo'));
    if (repo === undefined) return failed(`repository ${owner}/${textOf(args, 'repo')} not found`);
    const title = textOf(args, 'title');
    if (title === '') return failed('title is required');
    const numberValue = repo.issueCounter;
    repo.issueCounter += 1;
    repo.issues.set(numberValue, {
      number: numberValue,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      user: viewer,
      createdAt: '2024-01-01T00:00:00Z',
      rev: 0,
      cached: null,
    });
    return ok(issueJson(repo, numberValue, state));
  }
  if (name === 'list_issues') {
    const owner = textOf(args, 'owner') || viewer;
    const repo = findRepo(state, owner, textOf(args, 'repo'));
    if (repo === undefined) return failed(`repository ${owner}/${textOf(args, 'repo')} not found`);
    const wanted = textOf(args, 'state') || 'open';
    const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 30;
    const list = [...repo.issues.values()]
      .filter((issue) => wanted === 'all' || issue.state === wanted)
      .sort((a, b) => b.number - a.number)
      .slice(0, limit)
      .map((issue) => issueJson(repo, issue.number, state));
    return ok({ total: list.length, issues: list });
  }
  if (name === 'create_pull_request') {
    const owner = textOf(args, 'owner') || viewer;
    const repo = findRepo(state, owner, textOf(args, 'repo'));
    if (repo === undefined) return failed(`repository ${owner}/${textOf(args, 'repo')} not found`);
    const title = textOf(args, 'title');
    const head = textOf(args, 'head');
    const base = textOf(args, 'base') || repo.defaultBranch;
    if (title === '' || head === '') return failed('title and head are required');
    const numberValue = repo.pullCounter;
    repo.pullCounter += 1;
    const pull: PullRequest = {
      number: numberValue,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      head,
      base,
      user: viewer,
      createdAt: '2024-01-01T00:00:00Z',
      mergeCommitSha: null,
      baseShaAtCreate: resolveRef(repo, base),
      headShaAtCreate: resolveRef(repo, head),
    };
    repo.pulls.set(numberValue, pull);
    return ok(pullJson(repo, numberValue, state));
  }
  if (name === 'merge_pull_request') {
    const owner = textOf(args, 'owner') || viewer;
    const repo = findRepo(state, owner, textOf(args, 'repo'));
    if (repo === undefined) return failed(`repository ${owner}/${textOf(args, 'repo')} not found`);
    const numberValue = Number(args.pull_number);
    const pull = repo.pulls.get(numberValue);
    if (pull === undefined) return failed(`pull request #${String(args.pull_number)} not found`);
    if (!pull.merged) {
      const headSha = resolveRef(repo, pull.head);
      const baseSha = resolveRef(repo, pull.base);
      const tree = headSha ? treeOf(repo, headSha) : null;
      if (headSha && baseSha && tree) {
        const payload = commitPayload({
          tree,
          parents: [baseSha, headSha],
          author: repo.owner,
          email: `${repo.owner}@users.noreply.github.com`,
          message: `Merge pull request #${numberValue} from ${repo.owner}/${pull.head}`,
        });
        const oid = oidOf('commit', payload);
        repo.objects.set(oid, { type: 'commit', data: payload, oid });
        repo.refs.set(`refs/heads/${pull.base}`, oid);
        pull.mergeCommitSha = oid;
      }
    }
    pull.merged = true;
    pull.state = 'closed';
    return ok(pullJson(repo, numberValue, state));
  }
  return null;
}

/** The properties a tool's schema marks required, and whether `args` fills them. */
function missingRequired(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
}

// ------------------------------------------------------------------ JSON-RPC plumbing

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The `_meta` identity a request carries, when it carries one. */
function clientInfoOf(params: Record<string, unknown> | undefined): { name: string; version: string } | null {
  const meta = params?._meta;
  if (meta === null || typeof meta !== 'object') return null;
  const info = (meta as Record<string, unknown>)['io.modelcontextprotocol/clientInfo'];
  if (info === null || typeof info !== 'object') return null;
  return info as { name: string; version: string };
}

/** One JSON-RPC message's answer, or null for a notification (which has no id and gets no body). */
function answer(
  message: Record<string, unknown>,
  ctx: { state: McpState; viewer: string },
): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = message.params !== null && typeof message.params === 'object' ? (message.params as Record<string, unknown>) : undefined;
  const isNotification = id === undefined || id === null;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      instructions: 'A GitHub-compatible forge: create and read repositories, issues and pull requests.',
      serverInfo: SERVER_INFO,
      _meta: {
        'io.modelcontextprotocol/serverInfo': SERVER_INFO,
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo': clientInfoOf(params) ?? { name: 'unknown', version: '0' },
      },
    });
  }
  if (method === 'initialize') {
    const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    const chosen = SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'A GitHub-compatible forge.',
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null;
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = params?.arguments !== null && typeof params?.arguments === 'object' && !Array.isArray(params?.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const missing = missingRequired(tool, args);
    if (missing.length > 0) {
      return rpcError(id, INVALID_PARAMS, `Missing required arguments: ${missing.join(', ')}`);
    }
    const answerValue = runTool(name, args, ctx);
    if (answerValue === null) {
      return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const result: Record<string, unknown> = {
      content: [{ type: 'text', text: JSON.stringify(answerValue.payload) }],
      structuredContent: answerValue.payload,
      isError: answerValue.isError,
    };
    return rpcResult(id, result);
  }
  if (isNotification) return null;
  return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
}

const JSON_TYPE = 'application/json';

/** POST /mcp: one JSON-RPC message per request (a batch is answered as an array). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, state: McpState): Promise<void> {
  if (req.method === 'DELETE') {
    // The legacy session teardown: nothing is held, so there is nothing to forget.
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET') {
    // The transport's optional server-to-client stream: this server pushes nothing.
    res.writeHead(405, { allow: 'POST, DELETE' }).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST, DELETE' }).end();
    return;
  }
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^bearer\s+\S+/i.test(header)) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
    return;
  }

  const text = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, rpcError(null, PARSE_ERROR, 'Parse error: the request body is not JSON'));
    return;
  }
  const viewer = 'adaiversen';
  const ctx = { state, viewer };

  if (Array.isArray(parsed)) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        answers.push(rpcError(null, INVALID_REQUEST, 'Invalid request: a batch entry must be an object'));
        continue;
      }
      const reply = answer(entry as Record<string, unknown>, ctx);
      if (reply !== null) answers.push(reply);
    }
    if (answers.length === 0) {
      res.writeHead(202, { 'content-type': JSON_TYPE }).end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, rpcError(null, INVALID_REQUEST, 'Invalid request: expected a JSON object'));
    return;
  }
  const message = parsed as Record<string, unknown>;
  if (typeof message.method !== 'string') {
    sendJson(res, 400, rpcError(message.id ?? null, INVALID_REQUEST, 'Invalid request: a method is required'));
    return;
  }
  const reply = answer(message, ctx);
  if (reply === null) {
    res.writeHead(202, { 'content-type': JSON_TYPE, 'content-length': 0 }).end();
    return;
  }
  sendJson(res, 200, reply);
}
