/**
 * The tilting floor: the ground pitches and rolls under the body in small random pulses, to be
 * stood on. A body that has chosen a posture and holds it goes over at the first pulse; only one
 * that feels the tilt and answers it stays up, which is what the scenario is for.
 *
 * What actually happens is that gravity tilts, not the floor. The backends have no kinematic
 * floor to move, and for a floor that pivots about the point under the feet the two are the
 * same thing in the body's frame: a floor tilted by an angle is a gravity tilted by that angle
 * the other way, plus the pivot's own small motion. A viewer that wants to show the floor tilting
 * draws the whole world turned back by the tilt, so gravity is vertical on the screen and the
 * floor is what moves; the simulation itself does not know the difference.
 *
 * The pulses are deterministic from the seed: at each pulse a direction and a size are drawn,
 * the tilt ramps there over a tenth of a second, holds, and ramps back. Between pulses the floor
 * is level. The tilt is set every tick, absolutely, so a scrub or a restore lands on the right
 * floor without the script keeping any state that could go stale.
 */

import type { Vec3 } from '@bs-humany/frames';
import type { ScenarioApi } from './index.js';

export interface TiltingFloorSettings {
  /** The largest tilt a pulse reaches, in degrees. */
  readonly tilt: number;
  /** Seconds between pulses, give or take a third. */
  readonly every: number;
  /** Seconds a pulse is held at its tilt. */
  readonly hold: number;
  /** The seed the pulses are drawn from. */
  readonly seed: number;
}

/** A tilt of the floor: pitch about the world's X and roll about its Z, radians. */
export interface WorldTilt {
  readonly pitch: number;
  readonly roll: number;
}

const RAMP_UP = 0.1;
const RAMP_DOWN = 0.15;

function seeded(seed: number): () => number {
  let s = Math.round(seed) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
}

interface Pulse {
  readonly at: number;
  readonly pitch: number;
  readonly roll: number;
  readonly hold: number;
}

/** The pulses of the first `seconds` seconds, drawn from the seed. */
export function tiltPulses(settings: TiltingFloorSettings, seconds: number): Pulse[] {
  const random = seeded(settings.seed);
  const pulses: Pulse[] = [];
  const max = (settings.tilt * Math.PI) / 180;
  let at = Math.max(0.2, settings.every * (0.7 + 0.6 * random()));
  while (at < seconds) {
    const azimuth = random() * 2 * Math.PI;
    const size = max * (0.4 + 0.6 * random());
    pulses.push({
      at,
      pitch: size * Math.cos(azimuth),
      roll: size * Math.sin(azimuth),
      hold: settings.hold,
    });
    at += Math.max(0.2, settings.every * (0.7 + 0.6 * random()));
  }
  return pulses;
}

/** The tilt at `time`: the pulse in progress, ramped, or level. */
export function tiltAt(pulses: readonly Pulse[], time: number): WorldTilt {
  for (const pulse of pulses) {
    const since = time - pulse.at;
    if (since < 0) continue;
    const end = RAMP_UP + pulse.hold + RAMP_DOWN;
    if (since > end) continue;
    const gain =
      since < RAMP_UP
        ? since / RAMP_UP
        : since < RAMP_UP + pulse.hold
          ? 1
          : 1 - (since - RAMP_UP - pulse.hold) / RAMP_DOWN;
    return { pitch: pulse.pitch * gain, roll: pulse.roll * gain };
  }
  return { pitch: 0, roll: 0 };
}

/**
 * Gravity as a tilted floor feels it: the level gravity turned by the tilt the other way. A floor
 * whose far edge (+X) drops by `roll` sends gravity toward +X; one whose front (-Z) drops by
 * `pitch` sends it toward -Z.
 */
export function tiltedGravity(level: Vec3, tilt: WorldTilt): Vec3 {
  const g = Math.hypot(level.x, level.y, level.z);
  const cp = Math.cos(tilt.pitch);
  const sp = Math.sin(tilt.pitch);
  const cr = Math.cos(tilt.roll);
  const sr = Math.sin(tilt.roll);
  // Down, (0, -1, 0), pitched about X then rolled about Z.
  return { x: g * sr * cp, y: -g * cr * cp, z: -g * sp };
}

/** The script: the floor's tilt each tick, from the pulses the seed draws. */
export function tiltingFloor(
  settings: TiltingFloorSettings,
  seconds = 60,
): (time: number, api: ScenarioApi) => void {
  const pulses = tiltPulses(settings, seconds);
  return (time, api) => {
    const tilt = tiltAt(pulses, time);
    api.tiltWorld(tilt.pitch, tilt.roll);
  };
}
