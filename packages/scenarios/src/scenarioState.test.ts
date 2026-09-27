/**
 * A run's script state belongs to that run.
 *
 * A scenario's script is a closure, and some keep state in it: the shaken skull keeps the centre it
 * shakes about, captured on its first tick. When one built scenario served every run, a second run
 * through it -- the studio's Reset, a publish-pose rebuild when the fps or the profile changes, a
 * headset reset -- found that centre already set, skipped the grab, and shook a hand holding
 * nothing, so the head fell. These pin both ways out of that: `scenario(id)` builds afresh on every
 * call, and a script that is replayed from time zero starts over as if it had never run.
 */

import { type Vec3, vec3 } from '@bs-humany/frames';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, SCENARIO_DEFINITIONS, type ScenarioApi, scenario } from './index.js';

interface Recorded {
  readonly grabs: { segment: number; target: Vec3 }[];
  readonly moves: Vec3[];
}

/** A body of one segment, the head, standing wherever `at` says; every grab is written down. */
function fakeApi(at: { head: Vec3 }): { api: ScenarioApi; recorded: Recorded } {
  const recorded: Recorded = { grabs: [], moves: [] };
  const api: ScenarioApi = {
    segment: (id) => (id === 'head' ? 0 : -1),
    segmentPosition: () => ({ ...at.head }),
    grab: (segment, _local, target) => recorded.grabs.push({ segment, target: { ...target } }),
    moveGrab: (target) => recorded.moves.push({ ...target }),
    release: () => {},
    drive: () => {},
    moveStaticBox: () => {},
  };
  return { api, recorded };
}

function script(built: ReturnType<typeof scenario>) {
  const run = built.script;
  if (!run) throw new Error(`scenario '${built.id}' has no script`);
  return run;
}

describe('a run of skull-wiggle', () => {
  it('grabs the head in every run that scenario(id) builds', () => {
    const { api, recorded } = fakeApi({ head: vec3(0, 1.6, 0) });
    const first = scenario('skull-wiggle');
    const second = scenario('skull-wiggle');
    expect(second).not.toBe(first);
    script(first)(0, api);
    script(second)(0, api);
    expect(recorded.grabs).toHaveLength(2);
  });

  it('grabs it again when one built scenario is replayed from time zero', () => {
    const at = { head: vec3(0, 1.6, 0) };
    const { api, recorded } = fakeApi(at);
    const run = script(scenario('skull-wiggle'));
    run(0, api);
    run(0.001, api);
    // The head drifts over the first run; a Reset restores the body to where it started, but a
    // replay must centre the shake on wherever the head is at its own time zero, not on a centre
    // left over from before.
    at.head = vec3(0.1, 1.5, -0.05);
    run(0, api);
    expect(recorded.grabs).toHaveLength(2);
    expect(recorded.grabs[1]?.target).toEqual(at.head);
    // The first move of the replay is about the new centre: at time zero the cosine is one, so the
    // target is the full amplitude to one side of it along X and nowhere else.
    const replayMove = recorded.moves[2];
    expect(replayMove?.y).toBe(at.head.y);
    expect(replayMove?.z).toBe(at.head.z);
  });

  it('grabs once a run, not once a tick', () => {
    const { api, recorded } = fakeApi({ head: vec3(0, 1.6, 0) });
    const run = script(scenario('skull-wiggle'));
    for (let tick = 0; tick < 10; tick++) run(tick / 1000, api);
    expect(recorded.grabs).toHaveLength(1);
    expect(recorded.moves).toHaveLength(10);
  });
});

describe('scenario(id)', () => {
  it('builds each definition at its defaults, and names the known ids for an unknown one', () => {
    for (const definition of SCENARIO_DEFINITIONS) {
      const built = scenario(definition.id);
      expect(built.id).toBe(definition.id);
      expect(built.title).toBe(definition.title);
      expect(built.durationSeconds).toBe(definition.build().durationSeconds);
    }
    expect(() => scenario('no-such-scenario')).toThrow(
      `No scenario 'no-such-scenario'. Known: ${SCENARIOS.map((s) => s.id).join(', ')}.`,
    );
  });

  it('leaves SCENARIOS listing every definition, in order', () => {
    expect(SCENARIOS.map((s) => [s.id, s.title])).toEqual(
      SCENARIO_DEFINITIONS.map((d) => [d.id, d.title]),
    );
  });
});
