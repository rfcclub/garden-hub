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
