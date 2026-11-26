## ADDED Requirements

### Requirement: Do not follow an installation destination link
The service installer SHALL refuse a destination that is a symbolic link and SHALL avoid following a link substituted during replacement.

#### Scenario: Existing symbolic link
- **WHEN** the destination is a symbolic link to a file, directory, or nonexistent target
- **THEN** the command exits non-zero, the link and target are unchanged, and launchctl is not called

#### Scenario: Link swapped after the pre-check
- **WHEN** a link to a file replaces the destination immediately before the destination is opened
- **THEN** the command fails, launchctl is not called, and the file's content and mode remain unchanged

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
