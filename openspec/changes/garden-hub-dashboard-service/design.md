## Architecture
Refuse a symbolic-link destination before reading an existing plist. Open the destination via Node's filesystem API using `O_NOFOLLOW`, failing closed if the flag is unavailable, and write and chmod using the open file descriptor. A link inserted after the pre-check makes the open fail without following it. The open does not truncate: the descriptor is checked first, and anything other than a regular file with exactly one link (a hard link shares its inode with another file, which `O_NOFOLLOW` does not stop) is refused before truncating, writing and chmodding. Preserve the current comparison and `--force` behavior for existing regular files.

## Components
`tools/service/ghub-service.sh` and `tools/ghub-service.test.mjs`.

For the port-test repair, change only the test helper and assertion: remove the inherited dashboard port before applying each test's explicit environment, then extract one- to five-digit numeric XML string values as well as colon- or equals-prefixed port values. Assert that the only unique value is the explicit dashboard port.

## Data Model
No database or configuration schema changes.

## Test Strategy

| Scenario ID | Test File | Type |
|-------------|-----------|------|
| SVC-SYMLINK-1 | tools/ghub-service.test.mjs | isolated: file, dangling and directory links |
| SVC-SYMLINK-2 | tools/ghub-service.test.mjs | isolated: deterministic link replacement race |
| SVC-SYMLINK-3 | tools/ghub-service.test.mjs | isolated: regular install and force behavior |
| SVC-HARDLINK-1 | tools/ghub-service.test.mjs | isolated: pre-existing hard link, with and without `--force` |
| SVC-HARDLINK-2 | tools/ghub-service.test.mjs | isolated: hard link inserted between the pre-check and the open |
| SVC-003 | tools/ghub-service.test.mjs | inherited non-default port, exercised by running `GHUB_DASHBOARD_PORT=51235 node --test --test-name-pattern=SVC-003 tools/ghub-service.test.mjs` |
| port-mutation-probe | openspec/changes/garden-hub-dashboard-service/port-mutation-probe.mjs | six mutated temporary templates: numeric, colon, equals and their short forms |
| SVC-PORT-1 | tools/ghub-service.test.mjs | isolated: install refuses five invalid ports before writing |
| SVC-PORT-2 | tools/ghub-service.test.mjs | isolated: `--force` keeps an operator plist when the port is invalid |
| SVC-PORT-3 | tools/ghub-service.test.mjs | isolated PATH without node: no LaunchAgents directory, no launchctl call |
| SVC-PORT-4 | tools/ghub-service.test.mjs | print and install refuse leading-zero ports |

The test fixture has its own temporary home, dashboard stub, and fake launchctl. It never touches the live service. Both the focused Node test and full `npm test` are required.
`openspec/changes/garden-hub-dashboard-service/port-mutation-probe.mjs` creates only a temporary copy of the service template and test; no live service or runtime source is changed by the probe. It checks separate numeric, colon and equals variants, including short ports.

## Dependencies
Uses the existing Node executable and its built-in filesystem API; no additional package.

## Migration
No migration or live installation is included.
