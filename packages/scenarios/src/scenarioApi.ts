/**
 * The one way a runner hands a script its `ScenarioApi`.
 *
 * Three runners hand scripts an API -- the testkit's golden runner, the studio's simulation and
 * the trainer's rig -- and each used to write the object out by hand. They agreed on most of it
 * and differed in a few deliberate places (the studio skips a move that changes nothing; the rig
 * has no hand to grab with), but the agreement was by copy, so adding one thing a script may ask
 * for, such as a joint's state (OQ-024), meant three edits that had to stay in step. This builds
 * the object from callbacks instead: the parts every runner does the same way are written here
 * once, and the parts that differ are what each runner passes in.
 *
 * Plain callbacks and plain arrays only. This package describes experiments and must not learn
 * what a muscle set or a compiled articulation is (OQ-024), so a runner hands over the closures
 * that reach its own modules rather than the modules themselves.
 */

import type { StaticBox } from '@bs-humany/compiler';
import type { Quat, Vec3 } from '@bs-humany/frames';
import type { ScenarioApi } from './index.js';

/** A hand to grab with: the three calls a grab module answers, in the API's own shape. */
export interface ScenarioGrab {
  grab(segmentIndex: number, localPoint: Vec3, worldTarget: Vec3): void;
  moveTo(worldTarget: Vec3): void;
  release(): void;
}

/** The scenery a runner keeps a copy of, for whatever draws or publishes it. */
export interface ScenarioScenery {
  /**
   * The boxes as the runner draws them, updated in place whenever a script moves one, so what a
   * viewport draws or a showcase publishes is where the solver has the box rather than where the
   * scenery started. A tilting platform moves every tick, and a platform drawn level under a body
   * leaning against its slope makes a real force look like a trick of the rendering.
   */
  readonly boxes: StaticBox[];
  /**
   * Pass a move on only when it changes the list: a box already where it is asked to be is not
   * moved again, and a box the list does not have is not moved at all.
   *
   * The studio asks for this. A script that sets the same pose every tick then costs nothing, and
   * one that names a box the scenario did not declare does nothing rather than stopping a run
   * someone is watching. The goldens and the trainer pass every move through, as they always have.
   */
  readonly skipUnchanged?: boolean | undefined;
}

export interface ScenarioApiParts {
  /** Segment ids in index order: `segmentIds[i]` is segment `i`. */
  readonly segmentIds: readonly string[];
  /**
   * The body's segment origins, three numbers each, as the last solve left them. Read at every
   * call rather than copied, so it has to be the storage the solver writes into.
   */
  readonly position: ArrayLike<number>;
  /** A hand to grab with. Without one, `grab`, `moveGrab` and `release` do nothing. */
  readonly grab?: ScenarioGrab | undefined;
  /**
   * Where a script's muscle drive goes. Without it `drive` does nothing, which is what a run
   * without muscles does: a script may ask without checking first.
   */
  readonly drive?: ((unit: string, level: number) => void) | undefined;
  /** Put a box of the scenery where the script asks, in the solver. */
  readonly moveStaticBox: (id: string, position: Vec3, rotation: Quat) => void;
  /** The runner's own copy of the scenery, to keep in step with the solver. */
  readonly scenery?: ScenarioScenery | undefined;
}

function samePose(box: StaticBox, position: Vec3, rotation: Quat): boolean {
  // A box declared without a rotation never compares equal, so its first move always goes
  // through and gives it one.
  return (
    box.position.x === position.x &&
    box.position.y === position.y &&
    box.position.z === position.z &&
    box.rotation?.x === rotation.x &&
    box.rotation?.y === rotation.y &&
    box.rotation?.z === rotation.z &&
    box.rotation?.w === rotation.w
  );
}

/** A script's API over whatever the runner passes; see `ScenarioApiParts` for each part. */
export function createScenarioApi(parts: ScenarioApiParts): ScenarioApi {
  const { position, grab, drive, moveStaticBox, scenery } = parts;
  const index = new Map(parts.segmentIds.map((id, i) => [id, i]));
  return {
    segment: (id) => index.get(id) ?? -1,
    segmentPosition: (i) => ({
      x: position[3 * i] ?? 0,
      y: position[3 * i + 1] ?? 0,
      z: position[3 * i + 2] ?? 0,
    }),
    grab: (segment, local, target) => grab?.grab(segment, local, target),
    moveGrab: (target) => grab?.moveTo(target),
    release: () => grab?.release(),
    drive: (unit, level) => drive?.(unit, level),
    moveStaticBox: (id, at, rotation) => {
      if (scenery) {
        const boxes = scenery.boxes;
        const i = boxes.findIndex((b) => b.id === id);
        const box = boxes[i];
        if (scenery.skipUnchanged && (!box || samePose(box, at, rotation))) return;
        // Copied, so a script that reuses one vector for every tick's pose cannot move the
        // drawn box behind the solver's back.
        if (box) boxes[i] = { ...box, position: { ...at }, rotation: { ...rotation } };
      }
      moveStaticBox(id, at, rotation);
    },
  };
}
