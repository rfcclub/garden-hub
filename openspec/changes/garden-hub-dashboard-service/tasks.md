# Implementation Plan: garden-hub-dashboard-service

## Preparation
- [x] Review the current PR head and scope.
- [x] Approve the isolated fake-launchctl exception under delegated authority.

## Tasks

### Task 1: Refuse existing symlinks and avoid following a replacement

**Files:**
- Modify: `tools/service/ghub-service.sh`
- Test: `tools/ghub-service.test.mjs`

- [x] **Step 1: RED** Add temporary-home tests for file, dangling and directory symlinks, a deterministic swap before replacement, and regular-file behavior. Run `node --test --test-name-pattern='SVC-SYMLINK' tools/ghub-service.test.mjs`; capture the expected failure.
- [x] **Step 2: GREEN** Refuse a pre-existing destination link; open the destination with `O_NOFOLLOW`, fail if that flag is unavailable, and write and chmod through its file descriptor. Re-run the focused tests.
- [ ] **Step 3: Verify** Run the full `npm test`, shell syntax checks, `orca verify`, `orca gate-plan`, and `orca gate-code`. Report degraded enforcement and all warnings without changing their verdicts.

### Task 2: Repair the port assertion and isolate its environment

**Files:**
- Modify: `tools/ghub-service.test.mjs`
- Probe: `openspec/changes/garden-hub-dashboard-service/port-mutation-probe.mjs`, which creates a temporary fixture outside the repository.

- [x] **Step 1: RED** Run `SVC-003` with an inherited non-default dashboard port and demonstrate that an extra numeric XML string in a temporary template is accepted by the existing assertion.
- [x] **Step 2: GREEN** Clear the inherited port in the test helper before applying explicit overrides, and extract the rendered XML numeric strings as well as colon/equals-prefixed port values. Require the only unique port to be the explicit dashboard port.
- [ ] **Step 3: Verify** Run `env GHUB_DASHBOARD_PORT=51235 npm test` and `node openspec/changes/garden-hub-dashboard-service/port-mutation-probe.mjs <variant>` for each of `numeric`, `colon`, `equals`, `numeric-short`, `colon-short`, and `equals-short`. Run `orca verify`, `orca gate-plan`, and `orca gate-code`; preserve all failures and warnings.

## Verification
- [x] All relevant executable tests pass in the isolated fixture.
- [x] Existing regular-file and force behavior remains intact.
- [x] Review and publication remain separate from local implementation.

## Acceptance Criteria and Assertions

- **SC-1:** For symlinks to files, directories, and missing targets, `install --force` and `install` must return non-zero, preserve the link, preserve any existing target contents and mode, and make zero fake-launchctl calls. Test each shape separately under a temporary home.
- **SC-2:** For a symlink inserted after the pre-check, a controlled fake Node wrapper places the link immediately before the no-follow open. Assert that installation fails, no fake launchctl call occurs, and the linked file retains its original content and mode.
- **SC-3:** For new and forced regular-file installation, assert a readable regular plist with mode 0644, one fake bootstrap call, refusal to replace different content without force, and successful replacement with force.

The checked-in dashboard runtime uses Node, which is present in the test fixture. There are no blocking ambiguities: None. The install tests create and read only temporary fixtures, use a fake launchctl, and never install a real service.
