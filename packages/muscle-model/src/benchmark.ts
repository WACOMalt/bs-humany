/**
 * The single-muscle benchmark -- ticket N0.5, the gate on section 16's critical path.
 *
 * Muscle spec 13.3: drive one muscle with a constant activation and a sinusoidal length change,
 * and look at the force it makes. It is the cheapest experiment that exercises everything at once
 * -- both force-length curves, the force-velocity curve in both directions, the tendon, the
 * pennation geometry, the equilibrium solve and the integrator -- with no path solver, no
 * skeleton and no kernel in the way. If the fiber implementation is wrong, it is wrong here, and
 * finding it here is worth far more than finding it after a full body is built on top.
 *
 * This module runs the protocol and reports what happened. The judgements about whether what
 * happened is right live in `benchmark.test.ts`, so that the harness stays usable for reporting
 * as well as for testing -- section 13.5 wants a validation report out of the same machinery.
 */

import {
  type MusculotendonParameters,
  equilibriumFiberLength,
  solveEquilibrium,
  stepFiber,
} from './fiber.js';
import { solveRigidTendon } from './rigid.js';

/** A sinusoidal length drive, stated analytically so its velocity is exact rather than differenced. */
export interface LengthDrive {
  /** Metres. The length the sinusoid is centred on. */
  readonly meanLength: number;
  /** Metres. Half the peak-to-peak excursion. */
  readonly amplitude: number;
  /** Hertz. */
  readonly frequency: number;
}

export function driveLength(drive: LengthDrive, time: number): number {
  return drive.meanLength + drive.amplitude * Math.sin(2 * Math.PI * drive.frequency * time);
}

export function driveVelocity(drive: LengthDrive, time: number): number {
  const omega = 2 * Math.PI * drive.frequency;
  return drive.amplitude * omega * Math.cos(omega * time);
}

export interface BenchmarkCase {
  readonly name: string;
  readonly parameters: MusculotendonParameters;
  /** Held constant for the whole run, which is what makes the force profile readable. */
  readonly activation: number;
  readonly drive: LengthDrive;
  readonly duration: number;
  readonly dt: number;
}

export interface BenchmarkSample {
  readonly time: number;
  /** Metres. */
  readonly length: number;
  /** Metres per second. */
  readonly velocity: number;
  /** Optimal fiber lengths. */
  readonly fiberLength: number;
  readonly fiberVelocity: number;
  /** Newtons. */
  readonly tendonForce: number;
}

export interface BenchmarkResult {
  readonly name: string;
  readonly samples: readonly BenchmarkSample[];
  /** Newtons. */
  readonly peakForce: number;
  readonly minimumForce: number;
  readonly meanForce: number;
  readonly minimumFiberLength: number;
  readonly maximumFiberLength: number;
  /** Steps on which the equilibrium solve did not converge. Must be zero. */
  readonly failures: number;
  /** Steps on which the fiber left its valid range. Must be zero. */
  readonly outOfRange: number;
}

function summarise(
  name: string,
  samples: BenchmarkSample[],
  failures: number,
  outOfRange: number,
): BenchmarkResult {
  let peakForce = Number.NEGATIVE_INFINITY;
  let minimumForce = Number.POSITIVE_INFINITY;
  let total = 0;
  let minimumFiberLength = Number.POSITIVE_INFINITY;
  let maximumFiberLength = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    peakForce = Math.max(peakForce, s.tendonForce);
    minimumForce = Math.min(minimumForce, s.tendonForce);
    total += s.tendonForce;
    minimumFiberLength = Math.min(minimumFiberLength, s.fiberLength);
    maximumFiberLength = Math.max(maximumFiberLength, s.fiberLength);
  }
  return {
    name,
    samples,
    peakForce,
    minimumForce,
    meanForce: total / samples.length,
    minimumFiberLength,
    maximumFiberLength,
    failures,
    outOfRange,
  };
}

/**
 * The elastic-tendon run: the model this project actually uses.
 *
 * The fiber starts at the length that balances the forces at the initial unit length, so the
 * trace shows the muscle's response to the drive and not a start-up transient laid over it.
 */
export function runElastic(benchmark: BenchmarkCase): BenchmarkResult {
  const { parameters: p, activation, drive, dt } = benchmark;
  const startLength = driveLength(drive, 0);
  let state = {
    activation,
    fiberLength: equilibriumFiberLength(activation, startLength, p),
  };

  const steps = Math.round(benchmark.duration / dt);
  const samples: BenchmarkSample[] = [];
  let failures = 0;
  let outOfRange = 0;

  for (let i = 0; i <= steps; i++) {
    const time = i * dt;
    const length = driveLength(drive, time);
    const solution = solveEquilibrium(state, length, p);
    if (solution.failed) failures++;
    samples.push({
      time,
      length,
      velocity: driveVelocity(drive, time),
      fiberLength: state.fiberLength,
      fiberVelocity: solution.fiberVelocity,
      tendonForce: solution.tendonForce * p.maxIsometricForce,
    });
    if (i === steps) break;
    const stepped = stepFiber(state, length, activation, dt, p);
    if (stepped.outOfRange) outOfRange++;
    state = stepped.state;
  }

  return summarise(benchmark.name, samples, failures, outOfRange);
}

/** The same protocol through the rigid-tendon variant, for the tier comparison. */
export function runRigid(benchmark: BenchmarkCase): BenchmarkResult {
  const { parameters: p, activation, drive, dt } = benchmark;
  const steps = Math.round(benchmark.duration / dt);
  const samples: BenchmarkSample[] = [];
  let outOfRange = 0;

  for (let i = 0; i <= steps; i++) {
    const time = i * dt;
    const length = driveLength(drive, time);
    const velocity = driveVelocity(drive, time);
    const solution = solveRigidTendon(activation, length, velocity, p);
    if (solution.outOfRange) outOfRange++;
    samples.push({
      time,
      length,
      velocity,
      fiberLength: solution.fiberLength,
      fiberVelocity: solution.fiberVelocity,
      tendonForce: solution.tendonForce * p.maxIsometricForce,
    });
  }

  return summarise(benchmark.name, samples, 0, outOfRange);
}

/**
 * Work the muscle does on whatever is driving it, over the run, in joules.
 *
 * Force times the rate the unit is lengthening, integrated. Negative means the driver did work on
 * the muscle rather than the other way round, which is what a stretched passive muscle should
 * report and is the quantity the plausibility rule in section 13.4 is about.
 */
export function work(result: BenchmarkResult, dt: number): number {
  let total = 0;
  for (const s of result.samples) total -= s.tendonForce * s.velocity * dt;
  return total;
}

/**
 * The largest gap between two runs of the same case, as a fraction of the elastic run's peak
 * force. This is the number the `M2-fast` tier has to display.
 */
export function peakRelativeError(reference: BenchmarkResult, other: BenchmarkResult): number {
  let worst = 0;
  const count = Math.min(reference.samples.length, other.samples.length);
  for (let i = 0; i < count; i++) {
    const a = reference.samples[i];
    const b = other.samples[i];
    if (a === undefined || b === undefined) continue;
    worst = Math.max(worst, Math.abs(a.tendonForce - b.tendonForce));
  }
  return worst / reference.peakForce;
}
