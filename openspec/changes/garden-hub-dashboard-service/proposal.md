## Why
An existing symbolic link makes service installation overwrite the link target rather than the intended plist.

## What Changes
- Refuse a pre-existing destination symbolic link.
- Open the destination with the OS no-follow flag, then write and chmod using its descriptor.
- Test with a temporary home and fake launchctl.

## Capabilities

### New Capabilities
- `garden-hub-dashboard-service`: safe handling of the installation destination.

### Modified Capabilities
- None.

## Impact
Only the service installer, its existing test file, and this change record are affected. No live service operations are performed.
