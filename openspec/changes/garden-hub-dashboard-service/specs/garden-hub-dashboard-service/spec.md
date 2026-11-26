## ADDED Requirements

### Requirement: Do not follow an installation destination link
The service installer SHALL refuse a destination that is a symbolic link and SHALL avoid following a link substituted during replacement.

#### Scenario: Existing symbolic link
- **WHEN** the destination is a symbolic link to a file, directory, or nonexistent target
- **THEN** the command exits non-zero, the link and target are unchanged, and launchctl is not called

#### Scenario: Link swapped after the pre-check
- **WHEN** a link to a file replaces the destination immediately before the destination is opened
- **THEN** the command fails, launchctl is not called, and the file's content and mode remain unchanged

#### Scenario: Hard-linked destination
- **WHEN** the destination is a hard link to another file, either before the install or inserted after the pre-check, with or without `--force`
- **THEN** the command exits non-zero, the other file's content and mode are unchanged, and launchctl is not called

#### Scenario: Regular destination
- **WHEN** installation uses a new destination or force-replaces a regular plist
- **THEN** the resulting file has mode 0644 and fake launchctl receives the normal bootstrap call

### Requirement: Exercise the configured dashboard port
The service port test SHALL isolate its default-port case from the calling environment and SHALL detect additional port-looking values in the rendered plist.

#### Scenario: A calling environment has a different port
- **WHEN** the test process inherits a non-default dashboard port
- **THEN** the default-port check still tests the default and the explicit override check still tests its own configured port

#### Scenario: A rendered plist has an extra port
- **WHEN** a temporary mutated template adds a second numeric port string or a port after a colon or equals sign
- **THEN** the port assertion rejects that plist and identifies the unexpected values

### Requirement: Refuse an invalid dashboard port before writing
The service installer SHALL validate the dashboard port before writing a plist or contacting launchd, and SHALL accept only a canonical decimal port from 1 to 65535.

#### Scenario: Invalid port
- **WHEN** `GHUB_DASHBOARD_PORT` is non-numeric, zero, negative, above 65535, or written with a leading zero
- **THEN** `print` and `install` exit non-zero naming the variable, no plist is written, and launchctl is not called

#### Scenario: Forced install with an invalid port
- **WHEN** `install --force` runs with an invalid port over an existing operator plist
- **THEN** the existing plist keeps its contents and mode, and launchctl is not called

### Requirement: Fail closed without node
The service installer SHALL stop before creating any directory under the home directory when node cannot be resolved.

#### Scenario: Node is absent
- **WHEN** `install` runs with a PATH that provides the required system utilities but no node
- **THEN** the command exits non-zero mentioning node, no LaunchAgents directory is created, and launchctl is not called
