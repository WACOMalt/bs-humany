# Writing a module

A module is a piece of simulation that runs every tick. The physics is one, so are the passive
joints, the metrics and the grab. Yours will be another, and the kernel will not be able to tell
the difference: there is no privileged core, only modules that happen to have been written first.

This walks through the whole contract using `VestibularModule` in `@bs-humany/modules-sensing`,
which is small enough to read in one sitting and exercises every part of it. Read it alongside
this page.

## What a module is

```ts
interface SimModule {
  readonly manifest: ModuleManifest;
  init(ctx: ModuleInitContext): Promise<void> | void;
  step(ctx: ModuleStepContext): void;
  reset?(ctx: ModuleInitContext): void;
  dispose?(): void;
}
```

Four methods, and the manifest does most of the work.

## The manifest is a contract, not documentation

```ts
this.manifest = {
  id: 'bsums.xyz.bs-humany.vestibular',
  version: '1.0.0',
  phase: 'post',
  dependsOn: [],
  reads: [
    { id: BODY_POSE, version: CHANNEL_VERSION },
    { id: BODY_VELOCITY, version: CHANNEL_VERSION },
    { id: SIM_GRAVITY, version: CHANNEL_VERSION },
  ],
  writes: [{ id: SENSE_VESTIBULAR, version: CHANNEL_VERSION }],
  accumulates: [],
  gives: [senseVestibularSpec()],
};
```

Every channel you touch is declared. Asking for a view you did not declare throws at init, so a
module cannot quietly grow a dependency, and the kernel can order modules and detect conflicts
from the manifests alone.

- **`id`** is reverse-DNS and unique. It also seeds this module's random stream, so two modules
  never draw the same numbers.
- **`phase`** is `input`, `actuate`, `solve` or `post`. Modules that push forces run in
  `actuate`, before the solver; modules that read the result run in `post`, after it. The
  vestibular module reads this tick's pose and velocity, so it is `post`.
- **`dependsOn`** orders modules within a phase. Leave it empty unless you genuinely need to run
  after a particular module rather than after a particular channel is written.
- **`reads`**, **`writes`**, **`accumulates`**: a channel has exactly one writer, so two modules
  cannot both write `body.pose`. An accumulator is the exception, summed from many writers and
  zeroed each tick, which is how several modules can all push joint torque at once.
- **`gives`** declares channels this module creates. Publish a channel and anything may read it,
  including modules that do not know you exist. That is the whole design: an overlay, a test, or
  a nervous system later reads `sense.vestibular` without any of them referring to each other.

## Declaring a channel

```ts
export function senseVestibularSpec(): ChannelSpec {
  return {
    id: SENSE_VESTIBULAR,
    version: CHANNEL_VERSION,
    layout: 'SoA',
    fields: [
      { name: 'specificForce', dtype: 'f64', components: 3 },
      { name: 'angularVelocity', dtype: 'f64', components: 3 },
      { name: 'tiltFromVertical', dtype: 'f64', components: 1 },
    ],
    elementCount: 1,
    mode: 'single-writer',
    backing: 'shared',
  };
}
```

Channels are flat typed arrays, one per field, laid out structure-of-arrays. There are no
objects, because a hundred small objects per tick is a hundred allocations per tick. Say what
each field means and in what units and frame, in a comment next to it: `specificForce` is
metres per second squared in the head's own frame, and a reader who has to guess that will guess
wrong.

`backing: 'shared'` puts the channel in a `SharedArrayBuffer` where one is available, which is
what lets the simulation run in a worker later. Nothing in your module changes if it does.

## Binding views once

```ts
private bind(ctx: ModuleInitContext): void {
  this.orientation = ctx.read(BODY_POSE).fields.orientation as Float64Array;
  const velocity = ctx.read(BODY_VELOCITY);
  this.linear = velocity.fields.linear as Float64Array;
  this.angular = velocity.fields.angular as Float64Array;
  this.gravity = ctx.read(SIM_GRAVITY).fields.gravity as Float64Array;
  const out = ctx.write(SENSE_VESTIBULAR);
  this.specificForce = out.fields.specificForce as Float64Array;
  ...
}
```

Acquire views in `init` and keep them. Do not call `ctx.read` in `step`: it allocates and it
costs a lookup, every tick, forever.

## `step` is the hot path

It runs five hundred to a thousand times a second. Three rules, and `pnpm module:lint` enforces
the first two on every package that runs on the simulation thread, this one included.

1. **Allocate nothing.** No `new`, no array or object literals, no spread, no `map` or `filter`.
   Scratch space is a field on the class, created once. The lint flags the expressions that
   allocate; if it flags something that genuinely does not, the escape hatch is a
   `// allocation-ok: <reason>` comment on the line, which puts the exception in front of a
   reviewer.
2. **No wall-clock, no `Math.random`.** Simulation time is `ctx.tick * ctx.dt`. Randomness comes
   from `ctx.random`, seeded from the session and your module id, so a run repeats exactly.
   Determinism is what makes a bug reproducible from a session file.
3. **Do not reach for another module.** If you need something another module knows, it publishes
   a channel or it does not, and adding the channel is the fix. The vestibular module needs the
   gravity currently in force, which is not the articulation's compiled value once someone turns
   gravity off; the physics module publishes `sim.gravity`, so it reads that.

## State between ticks, and `reset`

Anything derived from more than one tick needs state, and state needs clearing when the timeline
jumps:

```ts
private readonly previousVelocity = new Float64Array(3);
private primed = false;

reset(ctx: ModuleInitContext): void {
  this.bind(ctx);
  this.primed = false;
  this.previousVelocity.fill(0);
}
```

`reset` runs when a snapshot is restored or the timeline is scrubbed. The views are new, so
rebind them; and last tick's velocity belongs to a moment that no longer precedes this one, so
forget it. Notice what happens on the first tick after that: rather than inventing an
acceleration from a difference it does not have, the module publishes zeros until it has two
samples. Publishing a plausible wrong number is worse than publishing nothing.

If your module holds state that must survive a save, implement `Stateful` as `PhysicsModule`
does, and the kernel will include it in the snapshot.

## Say what the model is not

The vestibular module's own header says that acceleration is differentiated, so it lags a tick
and is noisy at an impact, and that neither the otolith's membrane dynamics nor the canals'
high-pass are modelled. None of that stops it being useful; all of it stops somebody trusting it
for something it cannot carry. A module that reports a number is making a claim, and the
limitations belong next to the claim.

## Testing it

Register it with a kernel and a backend, run ticks, read the channel:

```ts
const kernel = new Kernel({ rateHz: 500, seed: 1 });
kernel.register(new PhysicsModule(new MujocoBackend(), articulation, { ground: { height: 0 } }));
kernel.register(new VestibularModule(articulation));
await kernel.init();
kernel.run(2000);
expect(magnitude(specificForce())).toBeCloseTo(9.80665, 1);
```

Test the physics, not the arithmetic. The tests for this module assert that a body held up by the
ground feels one g, that a falling body feels nothing, that turning gravity off is felt, and that
the rotation into the head frame does not change the length of a vector. Each of those would
still hold if the implementation were rewritten, which is what makes them worth having.

## Packaging

A module package depends on `@bs-humany/kernel` for the interfaces and on whichever package
declares the channels it reads. Add the package to `SIMULATION_PACKAGES` in
`tools/cli/bin/module-lint.mjs` so the determinism and allocation rules apply to it, and to the
root `tsconfig.json` references so `tsc --build` walks it.

Nothing else registers your module for you. The application decides what to run, which is why a
module is a thing you hand to a kernel rather than a thing that installs itself.
