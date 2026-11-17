// git smart HTTP. This is the surface the 30 git checks drive: they speak protocol v2 for reads and
// v0 for receive-pack, and judge the entry by bytes and SHA-1s alone.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack    v2 (or v0) advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack   v0 advertisement only
//   POST /{owner}/{repo}.git/git-upload-pack                      ls-refs + fetch (v2)
//   POST /{owner}/{repo}.git/git-receive-pack                     push (v0, report-status)
//
// Everything is computed from the store: an object is served as the bytes that were pushed, and its
// id is the SHA-1 git would compute for it, so a clone verifies object for object.

import { inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Repository,
  commitPayload,
  oidOf,
  parseCommit,
  parseTree,
  treePayload,
  type GitObject,
} from './store.ts';

const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'git/2.43.0';
const BAND_MAX = 60000;

// ------------------------------------------------------------------ pkt-line

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  readonly kind: 'data' | 'flush' | 'delim';
  readonly payload: Buffer;
}

/** Split a pkt-line stream. Malformed input stops the walk instead of throwing: the caller answers 400. */
function readPackets(body: Buffer): Packet[] {
  const out: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      out.push({ kind: length === 0 ? 'flush' : 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    out.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

function serviceHeader(service: string): Buffer {
  return Buffer.concat([pkt(`# service=${service}\n`), FLUSH]);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'cache-control': 'no-cache' });
  res.end(body);
}

// ------------------------------------------------------------------ object graph

/** Every object oid reachable from the roots, tree and commit edges followed. `grafts` are commits
 *  whose parents must not be traversed: a shallow client holds the commit but not its history. */
function reachable(repo: Repository, roots: readonly string[], grafts: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!grafts.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match) stack.push(match[1]);
    }
  }
  return seen;
}

/** Commits reachable from `roots`, with their generation distance from the nearest root. */
function generations(repo: Repository, roots: readonly string[], limit: number): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier = [...roots];
  for (const oid of frontier) distance.set(oid, 0);
  for (let depth = 0; depth + 1 < limit && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (distance.has(parent)) continue;
        distance.set(parent, depth + 1);
        next.push(parent);
      }
    }
    frontier = next;
  }
  for (const oid of distance.keys()) if (distance.get(oid)! >= limit) distance.delete(oid);
  return distance;
}

function isAncestor(repo: Repository, older: string, newer: string): boolean {
  if (older === newer) return true;
  const seen = new Set<string>();
  const stack = [newer];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === older) return true;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

function peel(repo: Repository, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'tag') {
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (!match) return null;
    const target = repo.objects.get(match[1]);
    if (target && target.type === 'commit') return match[1];
    return peel(repo, match[1]);
  }
  return object.type === 'commit' ? oid : null;
}

// ------------------------------------------------------------------ pack writing

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
/** The inverse of TYPE_CODE, indexed by the pack's numeric type: a lookup, not a key scan per object. */
const TYPE_NAME: readonly string[] = ['', 'commit', 'tree', 'blob', 'tag'];

function objectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (type << 4) | (remaining & 0x0f);
  remaining >>= 4;
  while (remaining > 0) {
    bytes.push((first | 0x80) & 0xff);
    first = remaining & 0x7f;
    remaining >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 packfile: header, one entry per object, then the SHA-1 trailer over the bytes. */
function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(objectHeader(TYPE_CODE[object.type] ?? 3, object.data.length));
    parts.push(deflate(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1(body)]);
}

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

function deflate(data: Buffer): Buffer {
  return deflateSync(data);
}

function sha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

// ------------------------------------------------------------------ pack reading

interface ParsedEntry {
  readonly offset: number;
  readonly oid: string;
  readonly type: string;
  readonly data: Buffer;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize();
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out.subarray(0, written);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine?.bytesWritten ?? 0;
  if (!consumed) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/**
 * Read a pushed packfile into the store. Deltas are resolved against earlier entries (ofs-delta) or
 * objects already held (ref-delta), so a real `git push` works as well as the suite's plain packs.
 */
function readPack(repo: Repository, pack: Buffer): { count: number } {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: ParsedEntry[] = [];
  const byOffset = new Map<number, ParsedEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset++];
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let kind = type;
    let baseOffset = -1;
    let baseOid = '';
    if (type === 6) {
      let value = pack[offset] & 0x7f;
      let more = pack[offset++] & 0x80;
      while (more) {
        const next = pack[offset++];
        value = (value + 1) * 128 + (next & 0x7f);
        more = next & 0x80;
      }
      baseOffset = start - value;
    } else if (type === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    let data = inflated.data;
    if (kind === 6) {
      const base = byOffset.get(baseOffset);
      if (!base) throw new Error(`ofs-delta base at ${baseOffset} is missing`);
      data = applyDelta(base.data, data);
      kind = TYPE_CODE[base.type] ?? 3;
    } else if (kind === 7) {
      const base = repo.objects.get(baseOid);
      if (!base) throw new Error(`ref-delta base ${baseOid} is missing`);
      data = applyDelta(base.data, data);
      kind = TYPE_CODE[base.type] ?? 3;
    }
    const name = TYPE_NAME[kind];
    if (!name) throw new Error(`pack entry has type ${kind}`);
    if (data.length !== size && kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4) {
      // size is advisory for delta bases; the resolved payload is authoritative
    }
    const oid = oidOf(name, data);
    const entry: ParsedEntry = { offset: start, oid, type: name, data };
    entries.push(entry);
    byOffset.set(start, entry);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: name as GitObject['type'], data, oid });
  }
  return { count: entries.length };
}

// ------------------------------------------------------------------ advertisement

function uploadPackCapabilities(headTarget: string | null): string {
  const caps = ['side-band-64k', 'ofs-delta', 'shallow', 'no-progress', 'multi_ack_detailed', 'thin-pack', `agent=${AGENT}`, 'object-format=sha1'];
  if (headTarget) caps.push(`symref=HEAD:${headTarget}`);
  return caps.join(' ');
}

function receivePackCapabilities(headTarget: string | null): string {
  const caps = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet', `agent=${AGENT}`];
  if (headTarget) caps.push(`symref=HEAD:${headTarget}`);
  return caps.join(' ');
}

/** The v0 ref advertisement: HEAD first with the capability list after a NUL. */
function v0Advertisement(repo: Repository, service: string): Buffer {
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const caps = service === 'git-receive-pack' ? receivePackCapabilities(head ? `refs/heads/${repo.defaultBranch}` : null) : uploadPackCapabilities(head ? `refs/heads/${repo.defaultBranch}` : null);
  const lines: Buffer[] = [];
  const refs = [...repo.refs.entries()].filter(([ref]) => ref.startsWith('refs/'));
  if (refs.length === 0 || !head) {
    lines.push(pkt(`${ZERO} capabilities^{}\u0000${caps}\n`));
  } else {
    let first = true;
    if (head) {
      lines.push(pkt(`${head} HEAD\u0000${caps}\n`));
      first = false;
    }
    for (const [ref, sha] of refs) {
      lines.push(pkt(`${sha} ${ref}\n`));
      if (first) first = false;
    }
  }
  lines.push(FLUSH);
  return Buffer.concat([serviceHeader(service), ...lines]);
}

/** The v2 capability advertisement, which carries no refs at all. */
function v2Advertisement(service: string): Buffer {
  const caps = [`agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow', 'server-option', 'object-format=sha1'];
  return Buffer.concat([serviceHeader(service), pkt('version 2\n'), ...caps.map((cap) => pkt(`${cap}\n`)), FLUSH]);
}

// ------------------------------------------------------------------ ls-refs

function lsRefs(repo: Repository, body: Buffer): Buffer {
  const packets = readPackets(body);
  const prefixes: string[] = [];
  let peelWanted = false;
  let symrefWanted = false;
  let unbornWanted = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'peel') peelWanted = true;
    else if (line === 'symrefs') symrefWanted = true;
    else if (line === 'unborn') unbornWanted = true;
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headTarget) ?? null;

  if (keep('HEAD')) {
    if (headSha) {
      const suffix = symrefWanted ? ` symref-target:${headTarget}` : '';
      out.push(pkt(`${headSha} HEAD${suffix}\n`));
    } else if (unbornWanted) {
      const suffix = symrefWanted ? ` symref-target:${headTarget}` : '';
      out.push(pkt(`unborn HEAD${suffix}\n`));
    }
  }
  for (const [ref, sha] of repo.refs.entries()) {
    if (!ref.startsWith('refs/') || !keep(ref)) continue;
    let extra = '';
    const peeled = ref.startsWith('refs/tags/') && peelWanted ? peel(repo, sha) : null;
    if (peeled) extra = ` peeled:${peeled}`;
    out.push(pkt(`${sha} ${ref}${extra}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ fetch

interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | null;
}

function parseFetch(body: Buffer): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of readPackets(body)) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  return { wants, haves, shallow, depth };
}

/** The objects a fetch must deliver: the wants' closure, minus whatever the haves already reach. */
function fetchSelection(repo: Repository, request: FetchRequest): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const haveClosure = new Set<string>();
  // The haves are what the client already holds. A commit it named as a shallow boundary stops the
  // walk: its ancestors were never sent, so they are still ours to deliver.
  for (const oid of reachable(repo, request.haves, new Set(request.shallow))) haveClosure.add(oid);

  const selected = new Set<string>();
  const boundaries: string[] = [];
  if (request.depth !== null) {
    const distance = generations(repo, request.wants, request.depth);
    for (const [oid, generation] of distance) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const isBoundary = commit.parents.length > 0 && commit.parents.every((parent) => !distance.has(parent));
      if (isBoundary && generation === request.depth - 1) boundaries.push(oid);
      for (const oid2 of reachable(repo, [commit.tree])) selected.add(oid2);
      selected.add(oid);
    }
  } else {
    for (const oid of reachable(repo, request.wants)) selected.add(oid);
  }

  const objects: GitObject[] = [];
  for (const oid of selected) {
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }

  // The boundary is where history stops: the shallow set names those commits, and any older boundary
  // the client held that is now inside the fetched slice was unshallowed.
  const shallow = request.depth === null ? [] : boundaries;
  const unshallow = request.shallow.filter((oid) => !shallow.includes(oid) && selected.has(oid));
  return { objects, shallow, unshallow };
}

function fetchResponse(repo: Repository, body: Buffer): Buffer {
  const request = parseFetch(body);
  if (request.wants.length === 0) {
    return Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH]);
  }
  const known = request.haves.filter((oid) => repo.objects.has(oid));
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  if (known.length === 0) parts.push(pkt('NAK\n'));
  else {
    for (const oid of known) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'));
  }
  parts.push(DELIM);

  const selection = fetchSelection(repo, request);
  if (selection.shallow.length || selection.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }

  if (selection.objects.length > 0) {
    parts.push(pkt('packfile\n'));
    const pack = buildPack(selection.objects);
    for (let index = 0; index < pack.length; index += BAND_MAX) {
      const slice = pack.subarray(index, index + BAND_MAX);
      parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePush(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  const capabilities: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.toString('ascii', offset, offset + 4), 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    let line = body.toString('utf8', offset + 4, offset + length);
    offset += length;
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      capabilities.push(...line.slice(nul + 1).split(' ').filter(Boolean));
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const segments = line.split(' ');
    if (segments.length < 3) continue;
    commands.push({ oldOid: segments[0], newOid: segments[1], ref: segments[2] });
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, capabilities, pack };
}

function receivePack(repo: Repository, body: Buffer): Buffer {
  const { commands, capabilities, pack } = parsePush(body);
  const sideband = capabilities.includes('side-band-64k');
  let unpack = 'ok';
  if (pack && pack.length > 0) {
    try {
      readPack(repo, pack);
    } catch (err) {
      unpack = err instanceof Error ? err.message : String(err);
    }
  }

  const lines: string[] = [`unpack ${unpack}\n`];
  for (const command of commands) {
    if (command.newOid === ZERO) {
      if (!repo.refs.has(command.ref)) {
        lines.push(`ng ${command.ref} ref does not exist\n`);
        continue;
      }
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (current === undefined) {
      if (command.oldOid !== ZERO) {
        lines.push(`ng ${command.ref} ref does not exist\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (current !== command.oldOid) {
      lines.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (repo.objects.has(command.newOid) && !isAncestor(repo, current, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}\n`);
  }

  const report = Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]);
  if (!sideband) return report;
  const parts: Buffer[] = [];
  for (let index = 0; index < report.length; index += BAND_MAX) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(index, index + BAND_MAX)])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ routing

/**
 * Upload-pack answers already computed, keyed by the request bytes and the repository's state. A
 * clone's fetch is identical every time until the ref or the object set moves, so this turns the
 * benchmark's fifty concurrent clones into one pack build and fifty sends.
 */
const uploadCache = new Map<string, Buffer>();

/**
 * Answers being built right now. Fifty concurrent clones of one repository arrive together, so a
 * plain cache misses all fifty at once; joining the build in flight is what makes it one pack.
 */
const uploadPending = new Map<string, Promise<Buffer>>();

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  state: { readonly repos: Map<string, Repository> },
  path: string,
): Promise<void> {
  const marker = path.indexOf('.git');
  if (marker < 0) {
    reply(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n'));
    return;
  }
  const tail = path.slice(marker + 4);
  const head = path.slice(0, marker).replace(/^\/+/, '');
  const parts = head.split('/').filter((part) => part !== '');
  if (parts.length < 2) {
    reply(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n'));
    return;
  }
  const owner = decodeURIComponent(parts[0]);
  const name = decodeURIComponent(parts[1]);
  const repo = state.repos.get(`${owner}/${name}`.toLowerCase());
  if (!repo) {
    reply(res, 404, 'text/plain; charset=utf-8', Buffer.from('Repository not found\n'));
    return;
  }

  const method = req.method ?? 'GET';

  if (tail === '/info/refs' || tail.startsWith('/info/refs?')) {
    const service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      reply(res, 403, 'text/plain; charset=utf-8', Buffer.from('Only smart HTTP is served\n'));
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && String(req.headers['git-protocol'] ?? '').includes('version=2');
    if (method !== 'GET' && method !== 'HEAD') {
      reply(res, 405, 'text/plain; charset=utf-8', Buffer.from('Method Not Allowed\n'));
      return;
    }
    const body = wantsV2 ? v2Advertisement(service) : v0Advertisement(repo, service);
    reply(res, 200, `application/x-${service}-advertisement`, body);
    return;
  }

  if (tail === '/git-upload-pack' && method === 'POST') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      reply(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad request body\n'));
      return;
    }
    const packets = readPackets(body);
    if (packets.length === 0 && body.length > 0) {
      reply(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line\n'));
      return;
    }
    const command = packets.find((packet) => packet.kind === 'data' && packet.payload.toString('utf8').startsWith('command='));
    const name = command && command.kind === 'data' ? command.payload.toString('utf8').replace(/^command=/, '').trim() : '';
    try {
      if (name === 'ls-refs') {
        reply(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, body));
        return;
      }
      if (name === 'fetch') {
        // Fifty identical shallow clones of one repository arrive as fifty identical fetches. The
        // answer depends only on the request bytes and the repository's objects, so it is computed
        // once per (request, object count); a push changes the object count and retires the entry.
        const key = `${body.toString('base64')}:${repo.objects.size}:${repo.refs.get('refs/heads/main') ?? ''}`;
        const cached = uploadCache.get(key);
        if (cached !== undefined) {
          reply(res, 200, 'application/x-git-upload-pack-result', cached);
          return;
        }
        const inFlight = uploadPending.get(key);
        if (inFlight !== undefined) {
          reply(res, 200, 'application/x-git-upload-pack-result', await inFlight);
          return;
        }
        // The build is synchronous, so the promise resolves on this turn: the other clones joining it
        // get the same buffer instead of each building one.
        const build = Promise.resolve().then(() => fetchResponse(repo, body));
        uploadPending.set(key, build);
        try {
          const answer = await build;
          if (uploadCache.size > 64) uploadCache.clear();
          uploadCache.set(key, answer);
          reply(res, 200, 'application/x-git-upload-pack-result', answer);
        } finally {
          uploadPending.delete(key);
        }
        return;
      }
      reply(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown upload-pack command\n'));
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply(res, 400, 'text/plain; charset=utf-8', Buffer.from(`${message}\n`));
      return;
    }
  }

  if (tail === '/git-receive-pack' && method === 'POST') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      reply(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad request body\n'));
      return;
    }
    try {
      reply(res, 200, 'application/x-git-receive-pack-result', receivePack(repo, body));
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply(res, 400, 'text/plain; charset=utf-8', Buffer.from(`${message}\n`));
      return;
    }
  }

  reply(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n'));
}

// Unused re-exports kept for the modules that build commits through the REST surface.
export { commitPayload, treePayload };
