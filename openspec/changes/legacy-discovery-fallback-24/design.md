## Architecture

Keep the server and wake adapters unchanged. Document the existing fallback in the installation and channel-wake guides. Add an in-process synthetic client and a stdio synthetic client that send the real frames.

## Adapter and lifecycle boundaries

A discovery method-not-found response is generic. Adapter selection happens during initialize; wake starts only after the initialized notification. In auto mode, negotiated common capability takes precedence, otherwise a known client-name adapter may be selected subject to its own trust and setup requirements. Tool handlers are not evidence that the wake lifecycle completed.

## Test Strategy

| Scenario | Evidence |
| --- | --- |
| MCP-001 | In-process request returns -32601 and does not write session state. |
| MCP-002 | In-process legacy handshake, tool calls, and body-free startup wake. |
| MCP-003 | Sequential stdio requests wait for their own reply id, tolerate a preceding notification, and verify order. |

Run the wake suite, core tests, collaboration suite and client/approval suites. Use a disposable mutation probe that permits wake to arrive first and delays the following tools/list response; the harness must still pass. Separately verify that a discovery-success mutation makes the fallback regression fail. Treat real-client fallback as unverified until an actual host test is run.

## Security and publication

No message body appears in wake envelopes. Publication history and secret checks are separate from tests and their actual outcome must be reported.

## Dependencies and Migration

No dependency, protocol, runtime configuration or migration change.

## Rollback plan

If the documentation or tests cause problems after merge, revert this change's documentation and test commits. The server and stored data are untouched, so no data rollback is required.
