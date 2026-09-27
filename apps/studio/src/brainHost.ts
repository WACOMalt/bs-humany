/**
 * The Brain tab's host: a policy in charge of the running body, and training from here.
 *
 * The panel (`brain.ts`) owns its checkpoint list, the cord's sliders and the training; this is
 * what it needs of the studio -- the running body to hand a policy to, the scene and body a
 * checkpoint's recipe puts on the panels and the one Undo that takes them off again, and the
 * follow mode the showcase is watched in.
 */

import type { HsdlDocument } from '@bs-humany/hsdl';
import type { PolicyFile } from '@bs-humany/modules-nerves';
import { profileRateHz } from '@bs-humany/scenarios';
import { REFERENCE_PROFILE } from '@bs-humany/skeleton';
import {
  type BrainPanel,
  type RecipeChange,
  type SetUpEffect,
  type TrainingRecipe,
  createBrainPanel,
} from './brain.js';
import type { BridgeFollower } from './follow.js';
import type { FollowView } from './followView.js';
import type { StudioRuns } from './runController.js';
import type { NormalisedSettings } from './session.js';
import type { Controls, SessionWiring } from './sessionWiring.js';
import {
  type SetUpNames,
  type StudioSetUp,
  setUpDifferences,
  setUpRestarts,
} from './training/setUp.js';
import type { BodyPanel } from './ui/bodyPanel.js';
import { messageOf, must, setControl } from './ui/dom.js';
import type { MusclePanel } from './ui/musclePanel.js';
import type { SimPanel } from './ui/simPanel.js';
import type { StatusLine } from './ui/transport.js';

export interface BrainStudioHost {
  readonly document: HsdlDocument;
  readonly runs: StudioRuns;
  readonly controls: Controls;
  readonly follower: BridgeFollower;
  readonly body: BodyPanel;
  readonly sim: SimPanel;
  readonly muscles: MusclePanel;
  readonly session: SessionWiring;
  readonly status: StatusLine;
  /** Following the bridge, started and stopped without the button's question. */
  readonly follow: Pick<FollowView, 'toggle'>;
  /**
   * Whether anything will read what a poll brings back: the Brain tab open, the follow mode, or
   * a headset whose Brain tab is drawn from this panel.
   */
  pollIsRead(): boolean;
  /**
   * Whether it is all right to throw the running body's recording away; asks when it is long.
   * @see Transport.confirmDiscard
   */
  confirmDiscard(what: string): Promise<boolean>;
}

export interface StudioBrain {
  readonly panel: BrainPanel;
  /**
   * Poll the dashboard every three seconds while something reads the answer, and once now.
   *
   * Three things read what the poll refreshes: the Brain tab while it is open; the follow mode,
   * whose status names the checkpoint the showcase plays; and the headset while the VR link is
   * live, whose Brain tab is drawn from this panel's state whichever desktop tab is showing. With
   * none of them there is nobody to ask for, and an absent dashboard is not asked every 3 s -- nor
   * at startup, where an unconditional first poll made every page open with two refused requests
   * in the console. A studio that reopens on the Brain tab is still asked at once, and opening the
   * tab later wakes the panel's own poll.
   */
  startPolling(): void;
}

/**
 * A slider's value as the slider would hold it: its min, its max and its step applied the way the
 * browser applies them when a value is set. A recipe's stature of 1.7532 m lands on a slider that
 * holds 1.755, and compared as 1.7532 it would be a difference that no set-up ever removes -- so
 * every Hand over would set the tabs up again and restart the run.
 */
function held(input: HTMLInputElement, value: number): number {
  const probe = input.cloneNode(false) as HTMLInputElement;
  probe.value = String(value);
  const read = Number(probe.value);
  return Number.isFinite(read) ? read : value;
}

export function createBrain(host: BrainStudioHost): StudioBrain {
  const { runs, controls: ui, follower, status } = host;
  const spine = {
    stretch: must<HTMLInputElement>('#spine-stretch'),
    velocity: must<HTMLInputElement>('#spine-velocity'),
    setPoint: must<HTMLInputElement>('#spine-setpoint'),
    inhibition: must<HTMLInputElement>('#spine-inhibition'),
    delaySeconds: must<HTMLInputElement>('#spine-delay'),
  };
  const authority = must<HTMLInputElement>('#brain-authority');

  /**
   * Put a cord on the Spine sliders, as though somebody had moved them.
   *
   * The sliders are the one owner of the cord: each one's `input` event sets the running body's
   * gains, and every run the studio starts is built with what they show. So a checkpoint's cord
   * goes onto the sliders rather than into the body behind them, and the panel and the body cannot
   * disagree about which reflexes are running.
   */
  const putSpine = (cord: NonNullable<NormalisedSettings['reflex']>): void => {
    setControl(spine.stretch, cord.stretch);
    setControl(spine.velocity, cord.velocity);
    setControl(spine.setPoint, cord.setPoint);
    setControl(spine.inhibition, cord.inhibition);
    setControl(spine.delaySeconds, cord.delaySeconds);
  };

  /**
   * The policy file last handed over from the panel, to tell a new hand-over from a change of
   * authority. The panel sends both through `handOver` with the same setup shape; only a new file
   * should bring its cord onto the sliders or be adopted again, because adopting refits the
   * weights and starts a remembering policy's context over, and a person who moved the sliders
   * after the hand-over did not ask for the checkpoint's cord back because they touched Authority.
   */
  let handedPolicy: PolicyFile | undefined;

  /** The scene and the profile as the pickers name them. */
  const names: SetUpNames = {
    scenario: (id) =>
      [...ui.scenario.options].find((o) => o.value === id)?.textContent?.trim() ?? id,
    profile: (id) => id.replace(/_.*/, '').toUpperCase(),
  };

  /**
   * The part of a set of settings a checkpoint's recipe reaches, for comparing. The step rate is
   * the one a run would step at: the one chosen, or the profile's own when none was, which is
   * what the slider shows while it is left alone.
   */
  const setUpOf = (s: NormalisedSettings): StudioSetUp => ({
    scenario: s.scenario,
    parameters: s.scenarioParameters ?? {},
    profile: s.profile,
    sex: s.sex,
    stature: s.stature,
    mass: s.mass,
    passive: s.passive,
    redistribute: s.redistribute,
    stepsPerSecond:
      s.stepsPerSecond ?? profileRateHz(host.document.segmentation.find((p) => p.id === s.profile)),
    cord: s.reflex,
    authority: s.brainAuthority ?? Number(authority.value),
    driving: Object.values(s.drive).some((level) => level !== 0),
  });

  /**
   * The settings a checkpoint's recipe leaves on the panels: the ones there now, with its scene,
   * body, joints, step rate, cord and authority in place of theirs, each as its control would hold
   * it. A profile this studio lacks becomes the reference one, as applying it does; its limb
   * proportions, if it has any, are left out, because nothing follows them yet.
   */
  const settingsFor = (recipe: TrainingRecipe): NormalisedSettings => {
    const now = host.session.currentSettings();
    const known = [...ui.profile.options].some((o) => o.value === recipe.profile);
    const cord = recipe.reflex;
    return {
      ...now,
      sex: held(ui.sex, recipe.morphology.sex),
      stature: held(ui.stature, recipe.morphology.stature),
      mass: held(ui.mass, recipe.morphology.mass),
      profile: known ? recipe.profile : REFERENCE_PROFILE,
      scenario: recipe.scenario,
      passive: recipe.passive,
      redistribute: recipe.redistribute,
      scenarioParameters: { ...recipe.parameters },
      // The timescale it was trained at. A policy learned against one timestep behaves
      // differently against another -- the contacts and the muscles' own dynamics both follow
      // the step -- so this is set rather than offered, and the Sim tab shows what it was set to.
      ...(recipe.stepsPerSecond
        ? { stepsPerSecond: held(ui.stepsPerSecond, recipe.stepsPerSecond) }
        : {}),
      // Trained with nothing under the brain: the sliders start where the training had them, at
      // zero, so what the body does is the policy's doing and not the policy plus a held pose.
      ...(recipe.feedforward.kind === 'none' ? { drive: {} } : {}),
      // The cord it was brought up over, so the panel says what this checkpoint knows rather
      // than what the last one did.
      ...(cord
        ? {
            reflex: {
              stretch: held(spine.stretch, cord.stretch),
              velocity: held(spine.velocity, cord.velocity),
              setPoint: held(spine.setPoint, cord.setPoint),
              inhibition: held(spine.inhibition, cord.inhibition),
              delaySeconds: held(spine.delaySeconds, cord.delaySeconds),
            },
          }
        : {}),
      brainAuthority: held(authority, recipe.authority),
    };
  };

  const changeTo = (target: NormalisedSettings): RecipeChange => {
    const differences = setUpDifferences(
      setUpOf(host.session.currentSettings()),
      setUpOf(target),
      names,
    );
    return { differences, restarts: setUpRestarts(differences) };
  };

  /**
   * Put a set of settings on the panels, restarting a running body only when something it is
   * built with changed. The settings as a whole go on through the session's own way of applying
   * them, which always restarts a running body; so when only what a running body takes live
   * differs -- the cord, the authority, the muscle sliders -- those are set on their own controls
   * instead, and a run somebody has been recording for a minute is not thrown away for a cord.
   */
  const put = (
    target: NormalisedSettings,
    restarts: boolean,
  ): { effect: SetUpEffect; unapplied?: string | undefined } => {
    const running = runs.simulation !== null;
    if (restarts) {
      const unapplied = host.session.applySettings(target);
      return { effect: running ? 'restarted' : 'nextRun', unapplied };
    }
    const now = host.session.currentSettings();
    if (target.reflex) {
      const cord = target.reflex;
      const same =
        now.reflex &&
        (Object.keys(cord) as (keyof typeof cord)[]).every((k) => now.reflex?.[k] === cord[k]);
      if (!same) putSpine(cord);
    }
    if (target.brainAuthority !== undefined && target.brainAuthority !== now.brainAuthority) {
      panel.act('authority', undefined, target.brainAuthority);
    }
    for (const [id, input] of host.muscles.driveInputs) {
      const level = target.drive[id] ?? 0;
      if (Number(input.value) !== level) setControl(input, level);
    }
    return { effect: running ? 'live' : 'nextRun' };
  };

  /** What a set-up or its Undo did to the run, in the words the event line ends with. */
  const effectPhrase = (effect: SetUpEffect): string =>
    effect === 'restarted'
      ? '; the running body was restarted with them.'
      : effect === 'live'
        ? '; the running body took them as it goes.'
        : '. They take effect on the next run.';

  const panel = createBrainPanel({
    handOver(setup) {
      const simulation = runs.simulation;
      if (!setup) {
        handedPolicy = undefined;
        simulation?.releaseBrain();
        return 'live';
      }
      const fresh = setup.policy !== handedPolicy;
      handedPolicy = setup.policy;
      // Onto the sliders before anything else, run or no run: the cord the checkpoint was trained
      // over is part of the body it knows, and the next run is built with what the sliders say.
      const cord = setup.policy.recipe?.reflex;
      if (fresh && cord) putSpine(cord);
      // Live: the nerves are in every muscle run, so the policy goes in between one control step
      // and the next, and nothing restarts. A run that is not going -- none yet, or one a set-up
      // is restarting -- takes it when it starts.
      if (!simulation) return 'deferred';
      if (!fresh) {
        simulation.setAuthority(setup.authority);
        return 'live';
      }
      try {
        simulation.handOver(setup.policy, setup.authority);
        return 'live';
      } catch (error) {
        status.announce(`The checkpoint could not be handed over: ${messageOf(error)}`, {
          error: true,
        });
        // And back to the panel, whose Hand over says it could not put the policy in -- rather
        // than "Policy chosen", which is what it said while nothing was in charge.
        return { error: messageOf(error) };
      }
    },
    musclesNextRun() {
      // As a run is built: the box, or a scenario that drives muscles whatever the box says.
      return ui.muscles.checked || host.sim.currentScenario()?.muscles === true;
    },
    setReflex(gains) {
      runs.simulation?.setReflex(gains);
    },
    startFollowing() {
      if (!follower.active) host.follow.toggle();
    },
    // The headset's Follow is the desktop's, both ways: without this there is no way to stop
    // following from in there. Through `toggle`, which never asks: see `FollowView.toggle`.
    toggleFollowing() {
      host.follow.toggle();
    },
    recipe() {
      return {
        scenario: ui.scenario.value,
        parameters: { ...(host.sim.scenarioValues.get(ui.scenario.value) ?? {}) },
        profile: ui.profile.value,
        morphology: host.body.currentMorphology(),
        passive: ui.passive.checked,
        redistribute: ui.redistribute.checked,
      };
    },
    recipeChange(recipe) {
      return changeTo(settingsFor(recipe));
    },
    // A checkpoint's recipe is a session's settings for the scene, the body and the cord; the
    // rest stays. What was there before is kept for one Undo, which goes back the same way.
    applyRecipe(recipe) {
      const before = host.session.currentSettings();
      const target = settingsFor(recipe);
      const { restarts } = changeTo(target);
      const { effect, unapplied } = put(target, restarts);
      // Said once, with what could not be put on the panels as asked at the end of it and the
      // whole of it marked as an error then, because a second message would replace the first.
      status.announce(
        `Set up as ${recipe.name} was trained: its scene, body, joints, cord and authority` +
          (recipe.stepsPerSecond ? `, and its ${recipe.stepsPerSecond} steps a second` : '') +
          (recipe.feedforward.kind === 'none' ? ', with the muscle sliders back to zero' : '') +
          effectPhrase(effect) +
          ' Undo on the Brain tab puts back what was there.' +
          (unapplied ? ` ${unapplied}` : ''),
        unapplied ? { error: true } : {},
      );
      return {
        effect,
        undo: {
          restarts: () => changeTo(before).restarts,
          apply() {
            const back = put(before, changeTo(before).restarts);
            status.announce(
              `Put back the settings from before ${recipe.name} was set up${effectPhrase(back.effect)}`,
            );
            return back.effect;
          },
        },
      };
    },
    confirmDiscard: host.confirmDiscard,
    fit() {
      const simulation = runs.simulation;
      const nerves = simulation?.nerves;
      if (!nerves || !simulation?.brainActive) return undefined;
      const inputs = nerves.observation.size;
      const outputs = nerves.outputs.length;
      return {
        carried: nerves.carried ?? { inputs, outputs },
        inputs,
        outputs,
        trainedRate: simulation.policyInCharge?.recipe?.stepsPerSecond,
        rate: simulation.stepsPerSecond,
        scriptDrives: simulation.scriptDrivingMuscles,
      };
    },
    following() {
      return follower.active;
    },
    publishedTrainingName() {
      // The showcase names the checkpoint it is playing in the status it writes.
      const published = follower.status as { training?: { task?: string } } | null;
      const name = published?.training?.task;
      return typeof name === 'string' && name !== '' ? name : undefined;
    },
  });

  const pollIfRead = (): void => {
    if (host.pollIsRead()) void panel.poll();
  };

  return {
    panel,
    startPolling() {
      pollIfRead();
      window.setInterval(pollIfRead, 3000);
    },
  };
}
