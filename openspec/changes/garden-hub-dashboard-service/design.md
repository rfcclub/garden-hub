## Architecture
Refuse a symbolic-link destination before reading an existing plist. Open the destination via Node's filesystem API using `O_NOFOLLOW`, failing closed if the flag is unavailable, and write and chmod using the open file descriptor. A link inserted after the pre-check makes the open fail without following it. Preserve the current comparison and `--force` behavior for existing regular files.

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
| SVC-PORT-1 | tools/ghub-service.test.mjs | inherited non-default port, exercised by running the named test under that environment |
| SVC-PORT-2 | tools/ghub-service.test.mjs | mutated temporary templates with extra numeric XML and colon/equals port values |

The test fixture has its own temporary home, dashboard stub, and fake launchctl. It never touches the live service. Both the focused Node test and full `npm test` are required.
`openspec/changes/garden-hub-dashboard-service/port-mutation-probe.mjs` creates only a temporary copy of the service template and test; no live service or runtime source is changed by the probe. It checks separate numeric, colon and equals variants, including short ports.

## Dependencies
Uses the existing Node executable and its built-in filesystem API; no additional package.

## Migration
No migration or live installation is included.
