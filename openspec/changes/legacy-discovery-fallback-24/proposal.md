## Why

Discovery-first clients need an accurate description and regression coverage for the existing legacy fallback. A discovery success response by itself would not implement the corresponding lifecycle.

## What Changes

- Document method-not-found fallback, initialization, wake selection and unsupported modern-only clients.
- Add synthetic in-process and stdio regression tests with deterministic response matching.

## Impact

Documentation and tests only. No production server behavior or dependency changes.
