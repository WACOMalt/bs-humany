/**
 * The tilting floor: the ground pitches and rolls under the body in small random pulses, to be
 * stood on. A body that has chosen a posture and holds it goes over at the first pulse; only one
 * that feels the tilt and answers it stays up, which is what the scenario is for.
 *
 * What turns is a platform the body stands on: a low plinth of scenery, tilted about the middle
 * of its own top face, with the floor left where it is underneath in case the body comes off.
 * Gravity does not move.
 *
 * Two things it is not. It is not a tilted *gravity*, which is a rotation away and easy to
 * mistake for this: under a tilted weight the body stays square to the floor and leans against
 * it, which is a room accelerating sideways, and the contact normal never moves. And it is not
 * the ground plane turning, which was tried and is worse than wrong -- a plane is infinite, so a
 * few degrees about the world's origin sweeps its surface a long way from wherever the feet are,
 * and the body is thrown off it. A plinth turned about the face the feet are on moves that face
 * hardly at all; only its angle changes, which is the whole of what a balance task is asking.
 *
 * The pulses are deterministic from the seed: at each pulse a direction and a size are drawn,
 * the tilt ramps there over a tenth of a second, holds, and ramps back. Between pulses the floor
 * is level. The tilt is set every tick, absolutely, so a scrub or a restore lands on the right
 * floor without the script keeping any state that could go stale.
 */

import { seededUniform } from '@bs-humany/modules-nerves';
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

/** The id the platform's box carries, and the name a script tilts it by. */
export const TILTING_PLATFORM = 'tilting_platform';

/** How thick the platform is, and how far across: a plinth, not a diving board. */
export const PLATFORM_HALF_EXTENTS = { x: 0.45, y: 0.04, z: 0.45 };
/** How high its top face sits above the ground, so a body that comes off it has somewhere to go. */
export const PLATFORM_TOP = 0.12;

/** A tilt of the floor: pitch about the world's X and roll about its Z, radians. */
export interface WorldTilt {
  readonly pitch: number;
  readonly roll: number;
}

const RAMP_UP = 0.1;
const RAMP_DOWN = 0.15;

interface Pulse {
  readonly at: number;
  readonly pitch: number;
  readonly roll: number;
  readonly hold: number;
}

/** The pulses of the first `seconds` seconds, drawn from the seed. */
export function tiltPulses(settings: TiltingFloorSettings, seconds: number): Pulse[] {
  // The nerves' xorshift32 stream. A seed is a number a slider sets, so it is rounded first: a
  // fractional seed names the same floor as the whole one nearest it, as it always has.
  const random = seededUniform(Math.round(settings.seed));
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
 * The floor's own rotation, as a quaternion: pitched about X, then rolled about Z, which is the
 * order `tiltAt` states a tilt in and the order a plane's normal follows it.
 */
export function groundRotation(tilt: WorldTilt): { x: number; y: number; z: number; w: number } {
  const hp = tilt.pitch / 2;
  const hr = tilt.roll / 2;
  const [sp, cp] = [Math.sin(hp), Math.cos(hp)];
  const [sr, cr] = [Math.sin(hr), Math.cos(hr)];
  // q = pitch(X) * roll(Z), with w first in the arithmetic and x, y, z, w in the value.
  return { x: sp * cr, y: sp * sr, z: cp * sr, w: cp * cr };
}

/**
 * Where the platform's box sits for a given tilt, turned about the middle of its top face.
 *
 * A box is posed by its centre, and turning a box about its centre swings the face the body is
 * standing on through an arc. Turned about that face instead, the face stays where it is and
 * only its angle changes -- so the feet are never suddenly somewhere the platform is not, which
 * is the whole of the difference between a tilt and a shove.
 */
export function platformPose(tilt: WorldTilt): {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
} {
  const rotation = groundRotation(tilt);
  const pivot = { x: 0, y: PLATFORM_TOP, z: 0 };
  const below = { x: 0, y: -PLATFORM_HALF_EXTENTS.y, z: 0 };
  // rotation * below, the centre's offset from the pivot once the platform has turned.
  const { x: qx, y: qy, z: qz, w: qw } = rotation;
  const tx = 2 * (qy * below.z - qz * below.y);
  const ty = 2 * (qz * below.x - qx * below.z);
  const tz = 2 * (qx * below.y - qy * below.x);
  return {
    position: {
      x: pivot.x + below.x + qw * tx + (qy * tz - qz * ty),
      y: pivot.y + below.y + qw * ty + (qz * tx - qx * tz),
      z: pivot.z + below.z + qw * tz + (qx * ty - qy * tx),
    },
    rotation,
  };
}

/** The platform as the scenario declares it, level, before anything has turned it. */
export function platformBox() {
  const at = platformPose({ pitch: 0, roll: 0 });
  return {
    id: TILTING_PLATFORM,
    halfExtents: PLATFORM_HALF_EXTENTS,
    position: at.position,
    rotation: at.rotation,
    // It is going to move, which a backend has to be told before it compiles.
    movable: true,
  };
}

/** The script: the platform's tilt each tick, from the pulses the seed draws. */
export function tiltingFloor(
  settings: TiltingFloorSettings,
  seconds = 60,
): (time: number, api: ScenarioApi) => void {
  const pulses = tiltPulses(settings, seconds);
  return (time, api) => {
    const at = platformPose(tiltAt(pulses, time));
    api.moveStaticBox(TILTING_PLATFORM, at.position, at.rotation);
  };
}
