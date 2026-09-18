# Fixtures

`pose-bridge.bin`, its sidecar and `pose-bridge.bin-muscles` are written by `pnpm generate:pose-bridge-fixture` from the TypeScript writer, and read by the Rust reader's tests. Neither is edited by hand; the generator's `--check` is a CI gate.
