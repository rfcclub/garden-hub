# Intent: Protect the service installation target

## Raw Request
A review reproduced an unrelated file being overwritten when the installation destination is a symbolic link.

## Problem
The service installer writes directly through the destination path. A symbolic link can redirect the write and chmod to an unrelated file.
The port test inherits the caller's configured port when it intends to test the default, and its port-detection expression misses values represented as XML strings.

## Desired Outcome
Installation refuses a pre-existing symbolic link, and a link substituted immediately before replacement cannot redirect a write or chmod.
The port test checks the default independently of the calling environment and detects extra port-looking values in the rendered plist.

## Users / Actors
- The operator preparing a local dashboard service.
- A reviewer executing isolated tests.

## Current Context
The existing change is under review. Its dashboard dependency is not yet merged. No real launchd operation is authorized.

## Proposed Direction
Fail closed on pre-existing links, and open the destination with the operating system no-follow flag so a link substituted after the pre-check cannot redirect the write.

## Scope
- Installer destination handling and isolated tests for the reported failure.
- Correct the existing service test's environment isolation and port assertion.

## Non-Goals
- Installation on a real machine, deployment, resolving unrelated review findings, or changing merge rules.

## Constraints
- Node built-ins only; no new dependency.
- An approved test-plan exception permits install-subcommand tests only in a temporary HOME with fake launchctl. No real launchd operations.
- Preserve normal regular-file replacement and the --force contract.

## Success Criteria
- Symlinks to files, directories, and missing targets are refused and untouched.
- A symlink inserted after the pre-check cannot redirect the write.
- New and forced regular-file installation succeed using a fake launchctl.
- The port test passes with an inherited non-default dashboard port and rejects an additional numeric plist string.

## Risks
- An interrupted write to an existing regular file can leave a partial plist, as in the current implementation. Rollback is outside this bounded fix.

## Ambiguities
### Blocking
- None.
### Non-Blocking
- Unrelated service review findings remain separate.

## Assumptions
- The checked-in runtime already requires Node.

## Spec Seeds
- WHEN the destination is a symbolic link THEN fail without modifying it or its target.
- WHEN a link is substituted before replacement THEN the target is never written or chmodded.

## Intent Approval
Status: APPROVED
Approved by: delegated operator authority, scoped to the test-plan exception
