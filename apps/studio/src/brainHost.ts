/**
 * The Brain tab's host: a policy in charge of the running body, and training from here.
 *
 * The panel (`brain.ts`) owns its checkpoint list, the cord's sliders and the training; this is
 * what it needs of the studio -- the running body to hand a policy to, the scene and body a
 * checkpoint's recipe puts on the panels, and the follow mode the showcase is watched in.
 */

import type { PolicyFile } from '@bs-humany/modules-nerves';
import { type BrainPanel, createBrainPanel } from './brain.js';
import type { BridgeFollower } from './follow.js';
import type { StudioRuns } from './runController.js';
import type { Controls, SessionWiring } from './sessionWiring.js';
import type { BodyPanel } from './ui/bodyPanel.js';
import { messageOf, setControl } from './ui/dom.js';
import type { SimPanel } from './ui/simPanel.js';
import type { StatusLine } from './ui/transport.js';

export interface BrainStudioHost {
  readonly runs: StudioRuns;
  readonly controls: Controls;
  readonly follower: BridgeFollower;
  readonly body: BodyPanel;
  readonly sim: SimPanel;
  readonly session: SessionWiring;
  readonly status: StatusLine;
  /** The Follow button, which starts and stops following the bridge. */
  readonly followButton: HTMLButtonElement;
  /**
   * Whether anything will read what a poll brings back: the Brain tab open, the follow mode, or
   * a headset whose Brain tab is drawn from this panel.
   */
  pollIsRead(): boolean;
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

export function createBrain(host: BrainStudioHost): StudioBrain {
  const { runs, controls: ui, follower, status } = host;

  /**
   * Put a cord on the Spine sliders, as though somebody had moved them.
   *
   * The sliders are the one owner of the cord: each one's `input` event sets the running body's
   * gains, and every run the studio starts is built with what they show. So a checkpoint's cord
   * goes onto the sliders rather than into the body behind them, and the panel and the body cannot
   * disagree about which reflexes are running.
   */
  const putSpine = (cord: NonNullable<NonNullable<PolicyFile['recipe']>['reflex']>): void => {
    const put = (selector: string, value: number): void => {
      const input = document.querySelector<HTMLInputElement>(selector);
      if (input) setControl(input, value);
    };
    put('#spine-stretch', cord.stretch);
    put('#spine-velocity', cord.velocity);
    put('#spine-setpoint', cord.setPoint);
    put('#spine-inhibition', cord.inhibition);
    put('#spine-delay', cord.delaySeconds);
  };

  /**
   * The policy file last handed over from the panel, to tell a new hand-over from a change of
   * authority. The panel sends both through `handOver` with the same setup shape; only a new file
   * should bring its cord onto the sliders or be adopted again, because adopting refits the
   * weights and starts a remembering policy's context over, and a person who moved the sliders
   * after the hand-over did not ask for the checkpoint's cord back because they touched Authority.
   */
  let handedPolicy: PolicyFile | undefined;

  const panel = createBrainPanel({
    handOver(setup) {
      const simulation = runs.simulation;
      if (!setup) {
        handedPolicy = undefined;
        simulation?.releaseBrain();
        return;
      }
      const fresh = setup.policy !== handedPolicy;
      handedPolicy = setup.policy;
      // Onto the sliders before anything else, run or no run: the cord the checkpoint was trained
      // over is part of the body it knows, and the next run is built with what the sliders say.
      const cord = setup.policy.recipe?.reflex;
      if (fresh && cord) putSpine(cord);
      // Live: the nerves are in every muscle run, so the policy goes in between one control step
      // and the next, and nothing restarts. A run that is not going takes it when it starts.
      if (!simulation) return;
      if (!fresh) {
        simulation.setAuthority(setup.authority);
        return;
      }
      try {
        simulation.handOver(setup.policy, setup.authority);
      } catch (error) {
        status.announce(`The checkpoint could not be handed over: ${messageOf(error)}`, {
          error: true,
        });
        // And back to the panel, whose Hand over catches it and says the checkpoint could not be
        // loaded -- rather than "Policy chosen", which is what it said while nothing was in charge.
        throw error;
      }
    },
    setReflex(gains) {
      runs.simulation?.setReflex(gains);
    },
    startFollowing() {
      if (!follower.active) host.followButton.click();
    },
    // The headset's Follow is the desktop's button, both ways: without this there is no way to
    // stop following from in there.
    toggleFollowing() {
      host.followButton.click();
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
    // A checkpoint's recipe is a session's settings for the scene and the body; the rest stays.
    applyRecipe(recipe) {
      // The cord and the memory it was brought up with, onto their sliders, so the panel says
      // what this checkpoint knows rather than what the last one did. Before the settings are read
      // back below, so that they carry this cord rather than put the last one back.
      if (recipe.reflex) putSpine(recipe.reflex);
      const memory = document.querySelector<HTMLInputElement>('#train-memory');
      if (memory && recipe.memory !== undefined) setControl(memory, recipe.memory);
      // Whether this lands on a running body, which the settings below restart with the body
      // carried across, or waits for the next run: the message says which.
      const running = runs.simulation !== null;
      // Its limb proportions, if it has any, are left out: nothing follows them yet.
      const unapplied = host.session.applySettings({
        ...host.session.currentSettings(),
        sex: recipe.morphology.sex,
        stature: recipe.morphology.stature,
        mass: recipe.morphology.mass,
        profile: recipe.profile,
        scenario: recipe.scenario,
        passive: recipe.passive,
        redistribute: recipe.redistribute,
        scenarioParameters: { ...recipe.parameters },
        // The timescale it was trained at. A policy learned against one timestep behaves
        // differently against another -- the contacts and the muscles' own dynamics both follow
        // the step -- so this is set rather than offered, and the Sim tab shows what it was set to.
        ...(recipe.stepsPerSecond ? { stepsPerSecond: recipe.stepsPerSecond } : {}),
        // Trained with nothing under the brain: the sliders start where the training had them, at
        // zero, so what the body does is the policy's doing and not the policy plus a held pose.
        ...(recipe.feedforward.kind === 'none' ? { drive: {} } : {}),
      });
      status.announce(
        `Set from the checkpoint ${recipe.name}: its scene, body and joints` +
          (recipe.stepsPerSecond ? `, and its ${recipe.stepsPerSecond} steps a second` : '') +
          (recipe.feedforward.kind === 'none' ? ', with the muscle sliders back to zero' : '') +
          (running
            ? '; the running body was restarted with them.'
            : '. They take effect on the next run.') +
          (unapplied ? ` ${unapplied}` : ''),
        unapplied ? { error: true } : {},
      );
    },
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
