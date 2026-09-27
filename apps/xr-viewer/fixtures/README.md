# Fixtures

`pose-bridge.bin`, its sidecar and `pose-bridge.bin-muscles` are written by `pnpm generate:pose-bridge-fixture` from the TypeScript writer, and read by the Rust reader's tests.

`status.json` is the panel status with every field of the contract filled, written by the same generator from `apps/studio/src/vrStatusSample.ts`, which is typed against `PanelStatus` in `packages/pose-bridge/src/panel.ts`. The Rust side's status test parses it and pins a value from every field the headset reads.

None of them is edited by hand; the generator's `--check` is a CI gate.
