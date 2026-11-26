# Implementation Plan: Legacy discovery fallback

## Status and chronology

The initial documentation and synthetic tests were authored before this local Orca plan was generated. This plan records the approved scope and remaining review corrections; it does not claim a pre-implementation plan gate or a production-code RED cycle.

## Tasks

### Task 1: Document the existing fallback

Files: `docs/channel-wake.md`, `INSTALL.md`.

- [ ] Describe the generic -32601 response, legacy initialize/initialized sequence, actual adapter-selection and trust conditions, and modern-only limitation.
- [ ] Check the text against `tools/ghub-mcp-server.mjs` and `tools/ghub-mcp-wake.mjs`; confirm tool availability is not inaccurately tied to initialize.

### Task 2: Exercise fallback in process and over stdio

SC-3: The stdio harness waits for the matching response when a wake notification arrives first, and retains duplicate-reply and ordering checks. The following steps implement and independently probe that requirement.

File: `tests/common-mcp-channel-wake/specs/discovery-fallback.test.ts`.

- [ ] Assert error/no state, initialization, tool calls, wake envelope and absence of message body.
- [ ] Wait for each stdio reply by matching the request id, retaining the one-reply check:

  ```ts
  await expect.poll(() => frames.filter((frame) => frame.id === id).length > 0).toBe(true);
  const replies = frames.filter((frame) => frame.id === id);
  expect(replies).toHaveLength(1);
  return replies[0];
  ```

- [ ] Keep sequential requests and verify reply ids `[1, 2, 3, 4]`. In MCP-004, begin waiting with an empty frame list, deliver the wake, observe the wait while only the wake is present, then deliver the reply with `setImmediate`; verify the wake remains present.
- [ ] Pin `serverName: 'garden-hub'` in the in-process connection and set `GHUB_MCP_SERVER_NAME: 'garden-hub'` in the stdio child environment so either fixture ignores a caller's configured server name.
- [ ] Add one regression test per fixture that stubs a different operator-configured name and verifies the expected server name; restore the environment after each test.
- [ ] Run the discovery spec with `GHUB_MCP_SERVER_NAME=custom-hub` as well as with the ordinary environment; both must pass while retaining the server-name assertion.
- [ ] Run a disposable probe that delays only the real stdio tools/list response by 300 ms; the corrected helper must pass. Restore the earlier helper that snapshots the frame count before sending and waits for any new frame; MCP-004 must fail when the wake arrives first. Also verify that delivering the reply via a microtask makes the observation check fail.
- [ ] Mutate discovery to return a success response in a disposable copy; the fallback tests must fail. Record actual results without claiming a test failure before its historical implementation.

### Task 3: Verify and prepare review publication

- [ ] Run `npm test`, `npm run test:wake`, `npm run test:orca`, and the client-auto-wake/approval tests; keep command exit status and actual results.
- [ ] Run `orca verify legacy-discovery-fallback-24` for coverage bookkeeping, `orca gate-plan legacy-discovery-fallback-24` and `orca gate-code legacy-discovery-fallback-24`; keep exact verdicts and limitations. These gates do not substitute for the test runs.
- [ ] Obtain independent review of the final exact head and report synthetic-client limitations.
- [ ] Run the full public-history and secret-value guard in a nonshallow fetched-ref clone; compare the candidate ref against its baseline and report errors and warnings without publishing sensitive detail.
- [ ] Archive only after the reviewed change is merged and the archive prerequisites are satisfied.
