/**
 * The step rate a profile runs at and how often a fresh policy reads the body at that rate,
 * each said once.
 *
 * Both used to be written out wherever a kernel was built -- the studio's simulation, the
 * training rig, the testkit's runner, the studio's brain host -- as `solver?.rate ?? 500` and
 * `Math.max(1, Math.round(rate / 100))`, and the copies had begun to drift: one read the panel's
 * slider, one did not. A policy trained in one of those places and run in another was then
 * evaluated at a different rate from the one it learnt at, and nothing said so. Here, every
 * caller gets the same answer to the same question.
 */

/**
 * Simulation steps a second for a profile: what the caller asked for, else the profile's own
 * solver rate, else 500.
 *
 * 500 is the rate the L1 and L2 profiles declare (packages/skeleton/src/segmentation.ts), the
 * middle of the three the spec names as meaningful (240, 500, 1000; see `SolverSettingsSchema`
 * in packages/hsdl/src/segmentation.ts), and the rate the desktop default was tuned at. Every
 * committed profile declares a rate, so this is only ever the answer for a hand-built profile
 * that left the solver out -- and for that one, the desktop's rate is the least surprising.
 */
export function profileRateHz(
  profile: { readonly solver?: { readonly rate?: number } | undefined } | undefined,
  override?: number,
): number {
  return override ?? profile?.solver?.rate ?? 500;
}

/**
 * Ticks between policy evaluations for a policy that recorded nothing about its own rate: as
 * near a hundred hertz as a whole number of ticks gets, and never less than every tick.
 *
 * A hundred hertz is the control rate the nerves have been trained at from the start -- five ticks
 * at 500 Hz, ten at 1000 -- and the rate every shipped checkpoint that records its own was trained
 * at. A policy that did record its rate keeps its own period instead; see `controlDivisorFor` in
 * nerves.ts.
 */
export function defaultControlDivisor(rate: number): number {
  return Math.max(1, Math.round(rate / 100));
}
