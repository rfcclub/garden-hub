## Why
An existing symbolic link makes service installation overwrite the link target rather than the intended plist.
The service port test can also fail because of the caller's environment and can miss an additional port in the rendered plist.

## What Changes
- Refuse a pre-existing destination symbolic link.
- Open the destination with the OS no-follow flag, then write and chmod using its descriptor.
- Test with a temporary home and fake launchctl.
- Isolate the tested port from the caller and check the numeric XML strings actually emitted by the plist.

## Capabilities

### New Capabilities
- `garden-hub-dashboard-service`: safe handling of the installation destination.

### Modified Capabilities
- None.

## Impact
Only the service installer, its existing test file, and this change record are affected. No live service operations are performed.
