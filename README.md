# ai-excited-gh-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zahradlina07/ai-excited-gh-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zahradlina07/ai-excited-gh-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP, the REST v3 API, the GraphQL v4 API
and an MCP server, all reading and writing one in-memory object store.

## What it serves

- **git smart HTTP** — `info/refs` advertisement for upload-pack (v0 and v2) and receive-pack (v0),
  `git-upload-pack` with `ls-refs` and `fetch` (shallow clones, deepening, and `ofs-delta` thin packs),
  `git-receive-pack` with `report-status` and side-band framing. Objects are stored as the exact bytes a
  push carried, so the client's SHA-1 verification holds for every blob, tree, commit and tag.
- **REST v3** — `/api/v3/user/repos`, repositories, branches, commits, contents (read, write, delete,
  directory listing), labels, issues, comments and pull requests, with GitHub's status codes, pagination
  `Link` headers, `x-github-request-id` and JSON error bodies.
- **GraphQL v4** — `/api/graphql` with a hand-written parser and executor: aliases, variables, inline
  fragments, enum lists, input objects, batched operations, introspection for `Issue`, `PullRequest`,
  `Repository` and `SearchType`, opaque global ids, and GitHub's convention that field errors are
  `200 OK` with an `errors` array while a missing token is `401`.
- **MCP** — `/mcp` streamable-HTTP JSON-RPC: `server/discover` plus the `initialize` fallback, protocol
  revisions `2026-07-28` through `2025-03-26`, and the six forge tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`). Every tool writes through
  the same store REST reads, so an object made over MCP is the same object over REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: it binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`,
polls until the environment reports done, then exits 0. To drive the server by hand during development
use `dev.ts`, which listens on a fixed port instead.

## Score

The contest's conformance suite runs 120 checks across git, REST, GraphQL, MCP, protocol and wire
behaviour, plus four timed performance workloads. This entry passes all 120.

## Layout

- `main.ts`: the harness lifecycle, kept as the starter ships it.
- `app.ts`: the router and every REST resource.
- `src/store.ts`: the object store, SHA-1 hashing and zlib payloads.
- `src/git.ts`: smart HTTP — advertisement, upload-pack, receive-pack.
- `src/graphql.ts`: the GraphQL parser, executor and schema.
- `src/mcp.ts`: the MCP JSON-RPC server and its six tools.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
