# Intent: Document and test discovery fallback

## Problem

Clients that try `server/discover` first may receive a generic method-not-found response. The server currently relies on the older initialize/initialized lifecycle to select a wake adapter and start wake delivery. A successful discovery response without the corresponding modern lifecycle could leave tools working while wake is not started.

## Desired Outcome

Document the supported fallback and retain executable regression coverage of the existing behavior. This change does not modify the production server.

## Scope

- Explain the existing 2025 initialization lifecycle and adapter selection.
- Exercise discovery failure, fallback, tools and wake using synthetic clients, including a stdio client.
- Keep the stdio harness correct when notifications precede a matching response.

## Non-Goals

- Implement or advertise a newer protocol lifecycle.
- Add a wake adapter, change recipient identity, deploy a service, or assert third-party client behavior without a real-host check.

## Constraints

- The generic error does not prove a protocol-version mismatch.
- Tool access and wake-adapter selection are distinct behaviors.
- Existing behavior is pinned by regression and mutation tests; do not invent a prior failing test for unchanged production code.
- The initial implementation preceded this local Orca record; the record is retrospective and does not claim otherwise.

## Success Criteria

- Discovery returns the existing generic method-not-found response without creating session state.
- Following initialization and the initialized notification, synthetic clients can list and call inbox tools and observe a body-free wake envelope; no wake is emitted before initialization is confirmed.
- The stdio harness waits for the matching response even when a wake notification arrives first, and retains duplicate-reply and ordering checks.
- Documentation states the fallback, actual adapter-selection rules and modern-only limitation without claiming a real client was verified.
- Relevant test suites and publication checks produce actual, separately reported results before review publication.

## Risks

- A synthetic client is not proof of any real client's fallback behavior.
- A missing real client host check remains an explicit limitation.

## Intent Approval

Status: APPROVED

Approved by: delegated project coordinator (local approval only)
Date: 2026-11-25
Reference: issue 24, approved body SHA-256 d90613b459f64fb5ec054721c4bee872040ce721a45e3e2a08e2f87ed1f5d066.
