/**
 * What the Brain tab offers, and what it says about it, worked out once.
 *
 * Both panels draw from this: the desktop sets its buttons from it, and the headset draws the
 * flags the desktop sends rather than recomputing them. That used to be the other way about --
 * four places on the desktop each set a button, and the headset had its own rules in Rust -- and
 * the copies drifted. Hand over was refused on both whenever no dashboard was running, although
 * the studio has held its own checkpoints, and shipped others, for as long as it has trained
 * without one. One pure function has one set of rules and a test that pins them.
 *
 * No DOM here, so the rules can be tested in Node and read by anything that has the facts.
 */

export interface BrainButtonInputs {
  /** Whether the dashboard server answered the last poll. */
  readonly serverUp: boolean;
  /** Whether a training run is going in this window, in its own workers. */
  readonly localRun: boolean;
  /** Stop has been pressed on that run and it is finishing its generation. */
  readonly localStopping: boolean;
  /** The server says it is training. */
  readonly trainingRunning: boolean;
  /** The server says there is something to stop: the trainer, or the showcase that outlives it. */
  readonly trainingStoppable: boolean;
  /** A trainer somebody started from a terminal is up, which the server cannot stop. */
  readonly elsewhere: boolean;
  /** The checkpoint chosen in the list, or '' for None. */
  readonly selected: string;
  /** A handover is loading its checkpoint now. */
  readonly handingOver: boolean;
  /** A policy has been handed over and not released. */
  readonly policySet: boolean;
  /**
   * The name on the form may be trained under as the form stands: a checkpoint name, and one
   * Start would not refuse -- not taken without Resume, not empty of anything to resume, not
   * shipped with the studio when there is no server. The recipe note says which when it is not.
   */
  readonly nameOk: boolean;
}

export interface BrainButtons {
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly canHandOver: boolean;
  readonly canRelease: boolean;
}

export function brainButtons(s: BrainButtonInputs): BrainButtons {
  return {
    // Without a server there is nothing to ask permission of: Start trains here, once at a time.
    // With one, the server decides, and a trainer it cannot see into refuses a second beside it.
    // Either way a name Start would refuse leaves it off, on both paths alike, so the button and
    // the note under the name never disagree about whether pressing it would do anything.
    canStart:
      s.nameOk && (s.serverUp ? !s.trainingRunning && !s.elsewhere && !s.localRun : !s.localRun),
    // A run in this window is stopped here and only here, whatever the server says; otherwise it
    // is the server's to stop, and without one there is nothing to stop.
    canStop: s.localRun ? !s.localStopping : s.serverUp && s.trainingStoppable,
    // Anything chosen can be handed over, server or not: the studio holds its own checkpoints and
    // ships others, and a policy already in the loop is swapped for the new one like the first.
    canHandOver: s.selected !== '' && !s.handingOver,
    canRelease: s.policySet,
  };
}

/**
 * The line under the checkpoint list.
 *
 * Without a server it says where this studio keeps what it trains, which is the thing a person
 * wants to know about the list they are looking at. It no longer sends them to a terminal: the
 * list is complete for what this studio can hand over, and handing over does not need a server.
 */
export function policyNote(s: {
  readonly serverUp: boolean;
  readonly count: number;
  /** The binary, which writes real files; a browser tab keeps its own copy instead. */
  readonly filesOnDisk: boolean;
  /** The checkpoint chosen before the list changed is not in it. */
  readonly lost: boolean;
}): string {
  const list = s.serverUp
    ? `${s.count} checkpoint${s.count === 1 ? '' : 's'} on this machine.`
    : `No dashboard server: these are the checkpoints the studio ships with and the ones trained here; checkpoints trained here are ${
        s.filesOnDisk ? 'files in the data folder' : 'kept in this browser'
      }.`;
  return s.lost ? `The chosen checkpoint is not in this list any more. ${list}` : list;
}

/**
 * The Stretch readout. 'off' only when the cord does nothing at all: damping answers the speed of
 * a stretch whatever the stretch gain is, so a stretch of zero with damping on is still a cord,
 * and saying 'off' there told a person the body had no reflexes when it had.
 */
export function stretchLabel(stretch: number, velocity: number): string {
  return stretch === 0 && velocity === 0 ? 'off' : stretch.toFixed(2);
}

/**
 * What the headset's Spine panel says under its sliders, sent from here so there is one place to
 * change it. It is the part that depends on the cord, and on what has been measured of it; the
 * measurement itself lives in its own document rather than in a table copied into two panels,
 * where it went stale the day the afferent's scale was fixed.
 */
export function spineNote(gains: { readonly stretch: number; readonly velocity: number }): string {
  const now =
    gains.stretch === 0 && gains.velocity === 0
      ? 'Stretch and Damping at zero is a body with no reflexes at all, the body every checkpoint before the cord was trained in.'
      : `The cord is on: stretch ${gains.stretch.toFixed(2)}, damping ${gains.velocity.toFixed(2)}.`;
  return `${now} Under the committed standing policy the best stretch measured is about 3.5–4; see docs/validation/reflex-gains.md.`;
}
