/**
 * The brain panel: a trained policy put in charge of the body, and training started from here.
 *
 * Both go through the dashboard server on this machine (`pnpm train:dashboard`) when one is
 * running, and through web workers in this very window when one is not, so a studio with no
 * terminal behind it can still train. The server lists the
 * saved checkpoints, serves any one of them, and starts and stops a training run the way a
 * terminal would. A checkpoint is fitted to whatever body is running by the names of its senses
 * and drives, so a policy trained on one profile drives another, and the panel says how much of
 * it carried. Handing over is live: the nerves are in every muscle run, so the policy is swapped
 * in between one control step and the next and nothing restarts. A run that is not going takes
 * the policy when it starts.
 *
 * Handing over needs no server. The studio holds what it trained itself and ships others, and a
 * checkpoint the server listed is found again under its bare name when the server goes away.
 *
 * Choosing a checkpoint in the list only shows it: what it was trained in, and how that differs
 * from the tabs. It used to set the tabs up there and then -- a running body restarted in the
 * checkpoint's scene and body, the muscle sliders went to zero and the training form changed, with
 * no way back, from the headset's list as much as the desktop's -- so browsing the list was not
 * safe. Set up as trained makes that change, Authority included, and one Undo takes it back; Hand
 * over makes it first when the tabs differ, because a policy only makes sense in the body it was
 * trained in. The headset has the same buttons.
 */

import {
  type PolicyFile,
  type SpinalRegion,
  type TrainedBody,
  compareCord,
  summariseDifferences,
} from '@bs-humany/modules-nerves';
import { type NervesSetup, SCENARIO_DEFINITIONS } from '@bs-humany/scenarios';
// The trainer's recipe module and nothing else of the trainer's, for the defaults and the rules:
// it imports nothing that runs, so it adds no body to the main thread.
import {
  DEFAULT_AUTHORITY,
  DEFAULT_BEHAVIOUR,
  DEFAULT_NOISE,
  DEFAULT_REFLEX,
  REFLEX_REGIONS,
  SEARCH_DEFAULTS,
  UI_RUN_DEFAULTS,
  describeStretch,
  isTask,
  regionStretchOf,
} from '@bs-humany/train/recipe';
import { brainButtons, policyNote, spineNote, stretchLabel } from './training/buttons.js';
import {
  BEST_COLOUR,
  MEAN_COLOUR,
  chartDescription,
  chartScale,
  chartX,
  chartY,
  generationRange,
} from './training/chart.js';
import { checkpointKey, checkpointStem, reselect } from './training/checkpointKey.js';
import { type LocalRun, startLocalTraining, workersHere } from './training/localTraining.js';
import {
  type Adjusted,
  type NameVerdictResult,
  adjustedPhrase,
  buildRecipe,
  checkpointNameOf,
  feedforwardPhrase,
  freeCheckpointName,
  nameAllowsStart,
  nameVerdict,
} from './training/recipe.js';
import { type SetUpDifference, describeSetUpDifferences } from './training/setUp.js';
import { shippedCheckpoint, shippedCheckpoints, trainedBefore } from './training/shipped.js';
import {
  type TrainingStatus,
  activitySource,
  progressPhrase,
  runLabel,
  trainingStatusLine,
} from './training/statusLine.js';
import {
  createCheckpointStore,
  forgetBrowserCheckpoint,
  holdsFilesOnDisk,
  listLocalCheckpoints,
  readLocalCheckpoint,
} from './training/store.js';
import { askInPage } from './ui/dom.js';

export const DEFAULT_DASHBOARD_URL = 'http://localhost:5280';

/** What a checkpoint was trained in; the trainer's `TrainingRecipe`, as the policy file keeps it. */
export type TrainingRecipe = NonNullable<PolicyFile['recipe']>;

/**
 * The showcase's brain, as it writes it ten times a second to `<data>/runs/<name>-activity.json`
 * -- the data directory `pnpm train:where` prints -- and the dashboard serves at
 * `/runs/<name>-activity.json`: one array a layer, senses first, drives last.
 */
export interface RemoteActivity {
  readonly name: string;
  readonly layers: readonly (readonly number[])[];
  readonly generation: number;
  readonly time: number;
  readonly up: boolean;
}

/** The part of a recipe the studio's own tabs supply: the scene, the body, the joints. */
export type RecipeInput = Pick<
  TrainingRecipe,
  'scenario' | 'parameters' | 'profile' | 'morphology' | 'passive' | 'redistribute'
>;

export interface CheckpointRow {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly profile: string | null;
  readonly sizes: readonly number[];
  readonly trained: {
    readonly generations: number;
    readonly fitness: number;
    readonly episodes: number;
    readonly at: string;
    /**
     * The generation `fitness` was scored at. A search centre is saved every generation and
     * scored only every few, so its fitness can be from a few generations back; a record is
     * scored where it is saved. Absent from files written before the trainer said so.
     */
    readonly scoredAt?: number;
    /** The population's mean in the generation it was saved at, which is nobody's score. */
    readonly populationMean?: number;
  } | null;
  readonly recipe?: TrainingRecipe | null;
  /**
   * Where the studio's own list found it: in the set the studio ships with, or in what this studio
   * trained itself. A server's rows say neither, except a shipped file the server was seeded with,
   * which is marked as shipped so the list says what it is either way.
   */
  readonly origin?: 'shipped' | 'local';
  /**
   * For a shipped checkpoint, what it was trained before -- `the current cord and the hand
   * muscles` -- when the body has changed under it since; its fitness was scored in that body.
   * @see trainedBefore
   */
  readonly trainedBefore?: string;
}

/**
 * The dashboard's `GET /train/status`, defined beside the line that is written from it.
 * @see trainingStatusLine
 */
export type { TrainingStatus } from './training/statusLine.js';

/**
 * What became of a handover: in the running body now, waiting for the next run because none is
 * going or the one going has no muscles, or refused, with the reason.
 */
export type HandOverResult = 'live' | 'deferred' | { readonly error: string };

/** What Set up as trained would change on the tabs, and whether that restarts a running body. */
export interface RecipeChange {
  readonly differences: readonly SetUpDifference[];
  /** Whether a running body is restarted for it, which throws its recording away. */
  readonly restarts: boolean;
}

/**
 * What a set-up, or its Undo, did to the run: restarted a running body in the new scene and body;
 * changed only what a running body takes live (the cord, the authority, the muscle sliders); or,
 * with no run, set the tabs up for the next.
 */
export type SetUpEffect = 'restarted' | 'live' | 'nextRun';

/** The one level of Undo a set-up leaves: the tabs as they were before it. */
export interface RecipeUndo {
  /** Whether putting them back now would restart a running body. */
  restarts(): boolean;
  /** Put them back. */
  apply(): SetUpEffect;
}

export interface BrainHost {
  /**
   * Put this policy in the running body's loop, live, between one control step and the next; or
   * take it out, with undefined. Says what became of it: `'live'` when the running body took it,
   * `'deferred'` when there is no run for it to go into yet (it goes in with the next), and the
   * error when the run refused it.
   */
  handOver(setup: NervesSetup | undefined): HandOverResult;
  /**
   * Whether the next run will have muscles for a policy to drive. Optional, and when a host does
   * not say, the panel does not guess: it says the policy goes in with the next run.
   */
  musclesNextRun?(): boolean;
  /** Start following the bridge, where the training's showcase publishes. */
  startFollowing(): void;
  /** Follow the bridge, or stop: the headset's one button, and the desktop's. */
  toggleFollowing(): void;
  /** The scene, body and joints as the tabs have them now: what a new checkpoint trains in. */
  recipe(): RecipeInput;
  /**
   * The checkpoint whose showcase is publishing to the bridge, if one is -- the showcase puts its
   * name in the status it writes -- so the brain being watched can be named even when this
   * server did not start it.
   */
  publishedTrainingName(): string | undefined;
  /**
   * What setting the tabs up from a checkpoint's recipe would change: its scene, body, joints and
   * step rate, its cord and authority, and the muscle sliders for one that learnt with nothing
   * under it. Compared as the controls would hold the recipe, so a value no slider can hold
   * exactly is not a difference that never goes away.
   */
  recipeChange(recipe: TrainingRecipe): RecipeChange;
  /**
   * Set the tabs up from a checkpoint's recipe, so the body handed over is the one it knows, and
   * say what that did to the run. A running body is restarted only when something it is built
   * with changed; the cord, the authority and the muscle sliders reach it live. The training
   * form is the panel's own, and is not touched. What comes back holds the tabs as they were, for
   * one Undo.
   */
  applyRecipe(recipe: TrainingRecipe): { readonly effect: SetUpEffect; readonly undo: RecipeUndo };
  /**
   * Resolve true when it is all right to throw away the running body's recording: there is none,
   * it is short, or the person said so. `what` names the act the way its button does. Only for a
   * press at the desktop: nothing the headset asks for waits on a dialog it cannot see.
   */
  confirmDiscard(what: string): Promise<boolean>;
  /**
   * What the running body could use of the policy, once it is in. `carried.body` is the nerves'
   * own comparison of the body the checkpoint was trained in with this one (`NervesModule.carried`),
   * which travels with the counts; a host that does not pass it along leaves the panel silent
   * about the body rather than guessing.
   *
   * `trainedRate` is the step rate the policy in the loop was trained at, when its file says, and
   * `rate` the one the running body steps at; `scriptDrives` is whether the scenario's script is
   * feeding muscles under it (`Simulation.scriptDrivingMuscles`). All three are about the policy
   * actually in the loop, not the one chosen in the list, and a host that leaves any of them out
   * leaves the panel silent about it.
   */
  fit():
    | {
        carried: { inputs: number; outputs: number; body?: TrainedBody };
        inputs: number;
        outputs: number;
        trainedRate?: number | undefined;
        rate?: number | undefined;
        scriptDrives?: boolean | undefined;
      }
    | undefined;
  /** Whether the run is currently following the bridge rather than its own. */
  following(): boolean;
  /**
   * Whether anybody can see the showcase's brain now, which is what the ten-hertz activity poll
   * is for. Optional: a host that does not say is asked for nothing, and the panel looks for
   * itself -- the Activity canvas in a panel that is not hidden, in a page that is not.
   */
  watchingBrain?(): boolean;
  /**
   * Set the cord's reflex gains on the running body. Optional: a host with no muscles has no
   * cord to set, and the panel is drawn either way.
   */
  setReflex?(gains: PanelCordGains): void;
}

/**
 * The stretch gain by region on the Spine panel: a region's own where its slider has been moved,
 * and none where it still follows Stretch, all regions -- the same meaning `SpinalGains` gives an
 * absent region, so the panel's cord is the module's without a translation between them.
 */
export type SpineRegions = Readonly<Partial<Record<SpinalRegion, number>>>;

/** The cord's five slider gains, and the stretch by region, as the Spine panel has them. */
export interface SpineCord {
  readonly stretch: number;
  readonly velocity: number;
  readonly setPoint: number;
  readonly inhibition: number;
  readonly delaySeconds: number;
  readonly regionStretch?: SpineRegions | undefined;
}

/** The panel's cord with the two gains it has no slider for, as the module and a recipe take it. */
export interface PanelCordGains extends SpineCord {
  readonly forceCeiling: number;
  readonly forceInhibition: number;
}

export interface BrainState {
  readonly serverUp: boolean;
  readonly active: boolean;
  readonly authority: number;
  readonly selected: string;
  readonly checkpoints: readonly { readonly id: string; readonly name: string }[];
  readonly fit: string;
  readonly training: string;
  readonly trainingRunning: boolean;
  /** Whether Stop would do anything: the trainer, or the showcase that outlives it. */
  readonly trainingStoppable: boolean;
  readonly following: boolean;
  /** The cord's gains, so the headset's Spine panel shows what the desktop has. */
  readonly reflex: SpineCord;
  /** Context units the next run will train with. */
  readonly memory: number;
  /**
   * What the Brain tab's buttons would do if pressed now, from the same rules the desktop's own
   * buttons are set from, so the headset draws them rather than guessing them again in Rust.
   */
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly canHandOver: boolean;
  readonly canRelease: boolean;
  /** Set up as trained: a checkpoint is chosen that says how it was trained. */
  readonly canSetUp: boolean;
  /** Undo of the last set-up: there is one to take back. */
  readonly canUndoSetUp: boolean;
  /**
   * The line under the checkpoint list, as the desktop has it: where the list comes from, or, with
   * a checkpoint chosen, how it was trained and how that differs from the tabs.
   */
  readonly policyNote: string;
  /** What the Spine panel says of the cord as it is set, for the headset to show as it is. */
  readonly spineNote: string;
}

/**
 * The cord the Spine panel opens on: the measured one, which is also the one the command-line
 * trainer gives a run that names none. The owner chose this on 2026-09-26 over opening with the
 * cord off, so that a body in the studio, a run trained in the window and a run trained at the
 * terminal all stand on the same reflexes unless somebody moves a slider. It is the recipe's
 * constant by name, not a copy of its numbers, so a re-measured cord reaches the panel by itself.
 */
export const OPENING_CORD = DEFAULT_REFLEX;

/**
 * The sentence the Spine note ends on: what a run trained from this panel will train with, and
 * how that stands against what the command-line trainer uses. The two sources of a checkpoint's
 * cord are the sliders here and the trainer's default there, and a person reading the note
 * before pressing Start should not have to know that to know which body the checkpoint will be.
 * Only the five gains the panel has a slider for are compared: the other two are the recipe's
 * own in both places, so they cannot differ.
 */
export function trainingCordNote(gains: SpineCord): string {
  // Within a hair rather than exactly, because a range input snaps its value to its step and a
  // browser is free to hand the snapped number back a rounding away from the one it was given.
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  // The stretch compared region by region, as the body answers with it: the panel's base is only
  // a region's gain where the region follows it, and the measured cord gives every region its own.
  // The panel's regions only: a region it does not name follows its base, not the default's.
  const panel = { ...DEFAULT_REFLEX, ...gains, regionStretch: gains.regionStretch };
  const measured =
    REFLEX_REGIONS.every((r) =>
      same(regionStretchOf(panel, r), regionStretchOf(DEFAULT_REFLEX, r)),
    ) &&
    same(gains.velocity, DEFAULT_REFLEX.velocity) &&
    same(gains.setPoint, DEFAULT_REFLEX.setPoint) &&
    same(gains.inhibition, DEFAULT_REFLEX.inhibition) &&
    same(gains.delaySeconds, DEFAULT_REFLEX.delaySeconds);
  return measured
    ? 'A run trained here trains on this cord, the measured one the command-line trainer uses too.'
    : `A run trained here trains on this cord as set; the command-line trainer uses the measured one (stretch ${describeStretch(DEFAULT_REFLEX)}, damping ${DEFAULT_REFLEX.velocity.toFixed(2)}) unless told otherwise.`;
}

/** What the headset is sent when there is no panel to ask: nothing chosen, nothing offered. */
export const IDLE_BRAIN_STATE: BrainState = {
  serverUp: false,
  active: false,
  authority: 0,
  selected: '',
  checkpoints: [],
  fit: '',
  training: '',
  trainingRunning: false,
  trainingStoppable: false,
  following: false,
  reflex: {
    stretch: OPENING_CORD.stretch,
    velocity: OPENING_CORD.velocity,
    setPoint: OPENING_CORD.setPoint,
    inhibition: OPENING_CORD.inhibition,
    delaySeconds: OPENING_CORD.delaySeconds,
    ...(OPENING_CORD.regionStretch ? { regionStretch: { ...OPENING_CORD.regionStretch } } : {}),
  },
  memory: 0,
  canStart: false,
  canStop: false,
  canHandOver: false,
  canRelease: false,
  canSetUp: false,
  canUndoSetUp: false,
  policyNote: '',
  spineNote: '',
};

/** The headset's hands on the panel: every button and slider it can press or move. */
export type BrainAction =
  | 'select'
  | 'setup'
  | 'undoSetup'
  | 'handover'
  | 'release'
  | 'authority'
  | 'trainStart'
  | 'trainStop'
  | 'follow'
  | 'reflexStretch'
  /** One region's stretch: `id` is the region, as `REFLEX_REGIONS` names it. */
  | 'reflexRegionStretch'
  | 'reflexVelocity'
  | 'reflexSetPoint'
  | 'reflexInhibition'
  | 'reflexDelay'
  | 'memory';

export interface BrainPanel {
  /** Refresh the checkpoint list and the training status; cheap, safe to call often. */
  poll(): Promise<void>;
  /**
   * The training showcase's brain as of the last tenth of a second, while one is publishing --
   * what the Activity panel draws when the policy in the loop is not this page's own.
   */
  remoteActivity(): RemoteActivity | undefined;
  /** What the panel would put in the loop for a new run, if a policy is chosen. */
  readonly setup: NervesSetup | undefined;
  /** The panel as the headset sees it. */
  state(): BrainState;
  /** The headset's hands on the panel: what the mouse would do, without going through a click. */
  act(action: BrainAction, id?: string, value?: number): void;
  /** What the cord's sliders say, for the run about to start: the panel's cord is the body's. */
  reflex(): PanelCordGains;
}

/**
 * How far a checkpoint was trained and what it scored, said so the number means what it says.
 *
 * A search centre is saved every generation and scored every few, so the fitness in its file is
 * often from a few generations before the one it was saved at: `gen 579, scored 3.94 at gen 575`.
 * And before the trainer scored the centre at all, it wrote the population's mean into a centre's
 * file as its fitness, which is the score of nobody -- an old centre that says nothing of when it
 * was scored is called what its number is.
 */
function trainedPhrase(name: string, t: NonNullable<CheckpointRow['trained']>): string {
  const fitness = typeof t.fitness === 'number' && Number.isFinite(t.fitness) ? t.fitness : null;
  if (fitness === null) return `gen ${t.generations}, not scored yet`;
  if (t.scoredAt !== undefined && t.scoredAt !== t.generations) {
    return `gen ${t.generations}, scored ${fitness.toFixed(2)} at gen ${t.scoredAt}`;
  }
  if (t.scoredAt === undefined && /\(search centre[,)]/.test(name)) {
    return `gen ${t.generations}, population mean ${fitness.toFixed(2)}`;
  }
  return `gen ${t.generations}, fitness ${fitness.toFixed(2)}`;
}

/**
 * The training form as Set up as trained finds it, for its Undo: the name and whether somebody
 * chose it, what is scored, what plays under the brain, the noise and the memory. As the controls
 * hold them, strings and all, so putting them back is putting back exactly what was there.
 */
interface FormState {
  readonly name: string;
  readonly nameTouched: boolean;
  readonly task: string;
  readonly feedforward: string;
  readonly noiseMotor: string;
  readonly noiseSense: string;
  readonly memory: string;
}

const must = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

export function createBrainPanel(host: BrainHost, dashboard = DEFAULT_DASHBOARD_URL): BrainPanel {
  const ui = {
    policy: must<HTMLSelectElement>('#brain-policy'),
    forget: must<HTMLButtonElement>('#brain-forget'),
    policyNote: must<HTMLElement>('#brain-policy-note'),
    authority: must<HTMLInputElement>('#brain-authority'),
    authorityValue: must<HTMLOutputElement>('#brain-authority-value'),
    handover: must<HTMLButtonElement>('#brain-handover'),
    release: must<HTMLButtonElement>('#brain-release'),
    setUp: must<HTMLButtonElement>('#brain-setup'),
    undoSetUp: must<HTMLButtonElement>('#brain-undo-setup'),
    fitNote: must<HTMLElement>('#brain-fit-note'),
    idleNote: must<HTMLElement>('#brain-idle-note'),
    generations: must<HTMLInputElement>('#train-generations'),
    population: must<HTMLInputElement>('#train-population'),
    seconds: must<HTMLInputElement>('#train-seconds'),
    workers: must<HTMLInputElement>('#train-workers'),
    workersValue: must<HTMLOutputElement>('#train-workers-value'),
    noiseMotor: must<HTMLInputElement>('#train-noise-motor'),
    noiseSense: must<HTMLInputElement>('#train-noise-sense'),
    memory: must<HTMLInputElement>('#train-memory'),
    spineStretch: must<HTMLInputElement>('#spine-stretch'),
    spineVelocity: must<HTMLInputElement>('#spine-velocity'),
    spineSetPoint: must<HTMLInputElement>('#spine-setpoint'),
    spineInhibition: must<HTMLInputElement>('#spine-inhibition'),
    spineDelay: must<HTMLInputElement>('#spine-delay'),
    spineRegions: Object.fromEntries(
      REFLEX_REGIONS.map((r) => [r, must<HTMLInputElement>(`#spine-stretch-${r.toLowerCase()}`)]),
    ) as Record<SpinalRegion, HTMLInputElement>,
    resume: must<HTMLInputElement>('#train-resume'),
    name: must<HTMLInputElement>('#train-name'),
    task: must<HTMLSelectElement>('#train-task'),
    feedforward: must<HTMLSelectElement>('#train-feedforward'),
    recipeNote: must<HTMLElement>('#train-recipe-note'),
    start: must<HTMLButtonElement>('#train-start'),
    stop: must<HTMLButtonElement>('#train-stop'),
    status: must<HTMLElement>('#train-status'),
    chart: must<HTMLCanvasElement>('#train-chart'),
    chartKey: must<HTMLElement>('#train-chart-key'),
  };
  let rows: CheckpointRow[] = [];
  let setup: NervesSetup | undefined;
  let serverUp = false;
  let trainingRunning = false;
  let trainingStoppable = false;
  /** A trainer started from a terminal is up, which the server can see and cannot stop. */
  let elsewhere = false;
  /** A handover is loading its checkpoint: one at a time, so two presses load it once. */
  let handingOver = false;
  /**
   * The chosen checkpoint by what it is rather than by what the list calls it, so the choice
   * survives the list being replaced by the other one when a server starts or stops.
   * @see checkpointKey
   */
  let chosenKey = '';
  /** The list as last drawn: a poll that finds the same list redraws nothing. */
  let rowsSignature: string | undefined;
  /** Whether the chosen checkpoint went missing from the list at the last change of it. */
  let chosenLost = false;
  /**
   * Asking a server that is not there, less and less often. Every poll used to try the dashboard
   * twice and fail, every three seconds, for as long as the Brain tab was open or the bridge was
   * followed -- two refused connections in the console each time, for a server most people never
   * start. After a failure the next try waits three seconds, then six, doubling to a minute; an
   * answer, or opening the Brain tab, starts the count again.
   */
  let probeDelayMs = 0;
  let nextProbeAt = 0;
  /** The checkpoint the server is training, or trained last: what a Start's note is about. */
  let trainingName: string | undefined;
  /** The server's run while its trainer or its showcase is up: whose brain file to read. */
  let serverRun: string | undefined;
  /** The checkpoint whoever is on the bridge is playing, when it is not this server's run. */
  let publishedName: string | undefined;
  let activity: RemoteActivity | undefined;
  /** A run going in this window, with no server: its handle, and what it has said so far. */
  let localRun: LocalRun | undefined;
  let localSeries: [number, number, number, number][] = [];
  let localStatus = '';
  /**
   * How far the generation under way has got -- `generation 3: 12 of 32 episodes` -- cleared when
   * it finishes, so the line says the run is moving in the seconds or minutes a generation takes
   * rather than repeating the last one's news until the next.
   */
  let localProgress = '';
  /**
   * Why this run's store would not keep what it was given, from the first write it refused, until
   * the next run starts. Said on every later line, because a run that is not saving looks exactly
   * like one that is, and finding out afterwards costs the run.
   */
  let localSaveProblem = '';
  /** The checkpoint the window is training, so it cannot be forgotten from under the run. */
  let localRunName: string | undefined;
  /** Asked to stop, and not stopped yet: a generation has to finish first. */
  let localStopping = false;
  /**
   * Why the last Start did not start, until something is done about it.
   *
   * It used to be written into the status line and then wiped a moment later by the poll that
   * follows every Start, so a refused run -- a name that already exists, most often -- looked
   * exactly like a button that does nothing. It stays until the name, the resume tick or the
   * server's own state changes, which are the three things that could make it untrue.
   */
  let refusal = '';
  /**
   * What the server said it did with the last Start that it took: the values it held to its
   * limits, and how a resumed checkpoint's recipe differs from the one it is now trained under.
   * Kept beside the run's status until the next Start or Stop, for the same reason as a refusal:
   * the poll after a Start would otherwise paint over it before it could be read.
   */
  let startNote = '';
  /** The checkpoint `startNote` is about, so it is only shown beside that run's status. */
  let startNoteFor: string | undefined;
  /**
   * Whether the name box holds a name somebody chose -- typed, or taken from a checkpoint picked
   * in the list -- rather than the one the panel offered. Until it does, the panel keeps offering
   * a name nothing is called yet, for the task that is chosen.
   */
  let nameTouched = false;
  /** Whether the list has been read once: until then no name can be judged against it. */
  let rowsLoaded = false;
  /** The row whose policy is in the loop, for what the fit note says about where it came from. */
  let handedRow: CheckpointRow | undefined;
  /**
   * The one Undo the last Set up as trained left: the tabs as they were, from the host, and the
   * training form as it was, from here. One level, because what a person reaches for after a
   * set-up they did not mean is the state they were in a moment before, not a history.
   */
  let undoSetUp:
    | { readonly name: string; readonly form: FormState; readonly tabs: RecipeUndo }
    | undefined;
  /** A set-up, an Undo or a hand-over is waiting on the person's answer: one at a time. */
  let settingUp = false;
  /**
   * The policy went in with no run for it to go into: none was going (`next`), or the set-up
   * before it restarted the one that was (`restart`). The fit note says which until a run takes
   * it, and is looked at again as soon as one does rather than at the next poll, which with the
   * Brain tab shut may never come.
   */
  let fitPending: 'restart' | 'next' | undefined;
  /** The checkpoints this browser holds of its own, by name: the only ones Forget can forget. */
  let browserHeld = new Set<string>();
  /**
   * Files in the binary's checkpoint folder that are not checkpoints, left out of the list and
   * named under it; emptied while a server is up, whose list is its own.
   */
  let skipped: readonly string[] = [];
  /** When the activity last actually changed: a file nobody is writing any more goes stale. */
  let activityChangedAt = 0;
  /** The last payload seen, whether or not it was shown: what "changed" is measured against. */
  let activitySeen = '';

  // The form opens on the trainer's own defaults, by name, rather than on numbers typed into the
  // page a second time: the dashboard falls back on the same ones for anything a request leaves
  // out, so a Start with the form untouched is a run the terminal would also call the default.
  ui.generations.value = String(UI_RUN_DEFAULTS.generations);
  ui.population.value = String(UI_RUN_DEFAULTS.population);
  ui.seconds.value = String(SEARCH_DEFAULTS.seconds);
  ui.noiseMotor.value = String(DEFAULT_NOISE.motor);
  ui.noiseSense.value = String(DEFAULT_NOISE.sense);
  ui.authority.value = String(DEFAULT_AUTHORITY);
  // And on the default behaviour's own choices, which are not a search setting: balance, nothing
  // under the brain, and its memory. The scenario is the Scene tab's, which opens on the one the
  // behaviour trains in, so an untouched form is `DEFAULT_BEHAVIOUR` under a free name.
  ui.task.value = DEFAULT_BEHAVIOUR.task;
  ui.feedforward.value = DEFAULT_BEHAVIOUR.feedforward.kind;
  ui.memory.value = String(DEFAULT_BEHAVIOUR.memory ?? 0);

  const readouts: [HTMLInputElement, string][] = [
    [ui.generations, '#train-generations-value'],
    [ui.population, '#train-population-value'],
    [ui.seconds, '#train-seconds-value'],
  ];
  for (const [input, selector] of readouts) {
    const out = must<HTMLOutputElement>(selector);
    const show = () => {
      out.textContent = input.value;
    };
    input.addEventListener('input', show);
    show();
  }
  // The noise sliders read in hundredths, so they want their own places rather than the
  // whole numbers the counts above are shown in.
  for (const [input, selector] of [
    [ui.noiseMotor, '#train-noise-motor-value'],
    [ui.noiseSense, '#train-noise-sense-value'],
  ] as [HTMLInputElement, string][]) {
    const out = must<HTMLOutputElement>(selector);
    const show = () => {
      const value = Number(input.value);
      out.textContent = value === 0 ? 'off' : value.toFixed(3);
    };
    input.addEventListener('input', show);
    show();
  }
  /**
   * The Workers readout, which says how many a run would really use. The slider is the terminal
   * server's as well, where every core is there to use, so it goes to sixty-four; a run in this
   * window makes no more than the window should hold, and the readout used to say sixteen over a
   * run of seven. Now it says both, and so does what a screen reader reads of the slider. The value
   * is left as it is, because a server that comes up takes it as asked.
   */
  const showWorkers = (): void => {
    const wanted = Number(ui.workers.value);
    const here = workersHere(wanted);
    const text =
      (!serverUp || localRun !== undefined) && wanted > here
        ? `${wanted} (${here} in this window)`
        : String(wanted);
    if (ui.workersValue.textContent !== text) ui.workersValue.textContent = text;
    if (ui.workers.getAttribute('aria-valuetext') !== text) {
      ui.workers.setAttribute('aria-valuetext', text);
    }
  };
  ui.workers.addEventListener('input', showWorkers);
  showWorkers();

  const showAuthority = () => {
    ui.authorityValue.textContent = Number(ui.authority.value).toFixed(2);
  };
  ui.authority.addEventListener('input', showAuthority);
  showAuthority();

  // Memory reads as a count, and "none" at zero, because 0 context units is a different kind of
  // policy rather than a small amount of one.
  const showMemory = () => {
    const n = Number(ui.memory.value);
    must<HTMLOutputElement>('#train-memory-value').textContent = n === 0 ? 'none' : String(n);
  };
  ui.memory.addEventListener('input', showMemory);
  showMemory();

  /**
   * What the cord's sliders say, in the shape the recipe and the module both take. The two gains
   * with no slider are the measured cord's, from the recipe module the trainer and the dashboard
   * read them from too, so a panel and a trainer never disagree about them.
   */
  /**
   * The regions whose Stretch slider has been moved since Stretch, all regions last was. The
   * others follow it: their sliders show its value and the cord gives them no gain of their own,
   * so they take the base. Moving Stretch, all regions puts every region back to following.
   */
  const ownStretch = new Set<SpinalRegion>();
  const regionsFromUi = (): SpineRegions =>
    Object.fromEntries(
      REFLEX_REGIONS.filter((r) => ownStretch.has(r)).map((r) => [
        r,
        Number(ui.spineRegions[r].value),
      ]),
    );
  const reflexFromUi = (): PanelCordGains => {
    const regionStretch = regionsFromUi();
    return {
      stretch: Number(ui.spineStretch.value),
      velocity: Number(ui.spineVelocity.value),
      setPoint: Number(ui.spineSetPoint.value),
      inhibition: Number(ui.spineInhibition.value),
      forceCeiling: DEFAULT_REFLEX.forceCeiling,
      forceInhibition: DEFAULT_REFLEX.forceInhibition,
      delaySeconds: Number(ui.spineDelay.value),
      ...(Object.keys(regionStretch).length > 0 ? { regionStretch } : {}),
    };
  };

  // The sliders open on the measured cord, the recipe's `DEFAULT_REFLEX` by name, because the
  // owner decided (2026-09-26) that the studio runs the cord the command-line trainer trains with.
  // Every run is built with what these sliders show and a run trained here takes its cord from
  // them too, so opening them anywhere else would have the live body, a scripted scenario with no
  // policy, and a checkpoint trained in this window all stand on a different cord from one trained
  // at the terminal -- which is how the panel used to open, with the cord off. The numbers come
  // from the recipe module rather than being typed into the page a second time, so the panel and
  // the trainer cannot drift apart. A checkpoint whose recipe records a cord puts that cord on
  // these sliders through Set up as trained and Hand over, as the one shipped today, balance, does.
  // One whose recipe records none -- a checkpoint from before the cord -- leaves the sliders where
  // they are, so it runs over the measured cord, not the no-cord body it learnt in, until someone
  // lowers the sliders.
  ui.spineStretch.value = String(OPENING_CORD.stretch);
  ui.spineVelocity.value = String(OPENING_CORD.velocity);
  ui.spineSetPoint.value = String(OPENING_CORD.setPoint);
  ui.spineInhibition.value = String(OPENING_CORD.inhibition);
  ui.spineDelay.value = String(OPENING_CORD.delaySeconds);
  for (const r of REFLEX_REGIONS) {
    const own = OPENING_CORD.regionStretch?.[r];
    ui.spineRegions[r].value = String(own ?? OPENING_CORD.stretch);
    if (own !== undefined) ownStretch.add(r);
  }

  // Stretch, all regions sets every region: each one's slider goes to it and follows it again.
  // Before `showSpine` below, which is added after this, so the body is handed the cord with its
  // regions already cleared.
  ui.spineStretch.addEventListener('input', () => {
    ownStretch.clear();
    for (const r of REFLEX_REGIONS) ui.spineRegions[r].value = ui.spineStretch.value;
  });
  for (const r of REFLEX_REGIONS) {
    ui.spineRegions[r].addEventListener('input', () => ownStretch.add(r));
  }

  const showSpine = () => {
    must<HTMLOutputElement>('#spine-stretch-value').textContent = stretchLabel(
      Number(ui.spineStretch.value),
      Number(ui.spineVelocity.value),
      regionsFromUi(),
    );
    for (const r of REFLEX_REGIONS) {
      const input = ui.spineRegions[r];
      const follows = !ownStretch.has(r);
      input.labels?.[0]?.classList.toggle('follows', follows);
      must<HTMLOutputElement>(`#spine-stretch-${r.toLowerCase()}-value`).textContent = follows
        ? `${Number(input.value).toFixed(2)} (all)`
        : Number(input.value).toFixed(2);
    }
    must<HTMLOutputElement>('#spine-velocity-value').textContent = Number(
      ui.spineVelocity.value,
    ).toFixed(2);
    must<HTMLOutputElement>('#spine-setpoint-value').textContent = Number(
      ui.spineSetPoint.value,
    ).toFixed(2);
    must<HTMLOutputElement>('#spine-inhibition-value').textContent = Number(
      ui.spineInhibition.value,
    ).toFixed(2);
    must<HTMLOutputElement>('#spine-delay-value').textContent = `${Math.round(
      Number(ui.spineDelay.value) * 1000,
    )} ms`;
    // The running body takes the gains at once: the cord is the body's, not the policy's, and
    // turning the reflexes up is something to watch happen rather than to restart for.
    host.setReflex?.(reflexFromUi());
  };
  for (const input of [
    ui.spineStretch,
    ...REFLEX_REGIONS.map((r) => ui.spineRegions[r]),
    ui.spineVelocity,
    ui.spineSetPoint,
    ui.spineInhibition,
    ui.spineDelay,
  ]) {
    input.addEventListener('input', showSpine);
  }
  showSpine();

  const scenarioTitle = (id: string) =>
    id === ''
      ? 'the reference stand'
      : (SCENARIO_DEFINITIONS.find((d) => d.id === id)?.title ?? id);
  const describe = (row: CheckpointRow): string => {
    const t = row.trained;
    const where = row.profile ? row.profile.replace(/_.*/, '').toUpperCase() : 'body unknown';
    const scene = row.recipe ? `, ${scenarioTitle(row.recipe.scenario)}` : '';
    // A shipped checkpoint says so, and says when the body has changed under it since: its
    // fitness was scored in that body, and a list that showed it beside a checkpoint trained
    // yesterday read as if the two numbers meant the same thing.
    const shipped =
      row.origin !== 'shipped'
        ? ''
        : row.trainedBefore
          ? ` (shipped; trained before ${row.trainedBefore})`
          : ' (shipped)';
    return t
      ? `${row.name} — ${row.task}, ${where}${scene}, ${trainedPhrase(row.name, t)}${shipped}`
      : `${row.name} — ${row.task}, ${where}${scene}${shipped}`;
  };

  /** What Start would train: the tabs as they are and the form as it is, in the recipe's shape. */
  const formRecipe = (): TrainingRecipe =>
    buildRecipe(host.recipe(), {
      name: ui.name.value,
      task: ui.task.value,
      feedforward: ui.feedforward.value,
      authority: Number(ui.authority.value),
      noise: { motor: Number(ui.noiseMotor.value), sense: Number(ui.noiseSense.value) },
      reflex: reflexFromUi(),
      memory: Number(ui.memory.value),
    });
  /** What Start would do with that recipe's name, from the list as it was last drawn. */
  const verdictOf = (recipe: TrainingRecipe): NameVerdictResult =>
    nameVerdict({
      name: recipe.name,
      task: recipe.task,
      rows,
      resume: ui.resume.checked,
      serverUp,
      recipe,
    });
  /**
   * The recipe Start sends, or why it will not send one. One resolver for every way a run is
   * started -- the button, the headset's `trainStart`, with a server or without -- and asked before
   * either path is chosen, so a name the note refuses is refused by Start too. It used to be
   * checked by the server and not by the window, whose run trained whatever the box said, or the
   * task's name when the box was empty.
   */
  const recipeFromUi = (): { readonly recipe: TrainingRecipe } | { readonly error: string } => {
    const recipe = formRecipe();
    const verdict = verdictOf(recipe);
    return nameAllowsStart(verdict.verdict)
      ? { recipe }
      : { error: verdict.problem ?? verdict.text };
  };
  /** What Start would train, from the tabs as they are, so it is said before it is done. */
  const showRecipe = () => {
    const recipe = formRecipe();
    const verdict = verdictOf(recipe);
    if (!nameAllowsStart(verdict.verdict)) {
      ui.recipeNote.textContent = verdict.text;
      return;
    }
    const where = recipe.profile.replace(/_.*/, '').toUpperCase();
    const body = `${recipe.morphology.stature.toFixed(2)} m, ${recipe.morphology.mass.toFixed(0)} kg`;
    const scored = recipe.task === 'balance' ? 'a still, level head' : 'standing';
    // A resume trains the checkpoint in whatever the tabs say now, which is how a policy is
    // carried to another body; said, field by field, so it is never done without being seen.
    const changed = verdict.changes ? `, not as it was trained: ${verdict.changes}` : '';
    ui.recipeNote.textContent = `${verdict.text}: the brain ${feedforwardPhrase(ui.feedforward.value)}, in ${scenarioTitle(recipe.scenario)} on ${where} (${body}), scored on ${scored}${changed}.`;
  };
  /**
   * Changing what Start would do makes any refusal of the last attempt stale, and may make Start
   * possible or impossible, so the buttons are worked out again from what the panel already knows
   * rather than at the next poll.
   */
  const reconsider = (): void => {
    if (refusal) {
      refusal = '';
      ui.status.textContent = '';
    }
    showRecipe();
    setButtons();
  };
  ui.name.addEventListener('input', () => {
    nameTouched = true;
    reconsider();
  });
  ui.feedforward.addEventListener('change', reconsider);
  ui.task.addEventListener('change', () => {
    // Until a name has been chosen, the offered one follows the task: `balance` for a balance
    // run, rather than a balance run under the name the panel offered for a stand.
    if (!nameTouched && rowsLoaded) ui.name.value = freeCheckpointName(rows, ui.task.value);
    reconsider();
  });
  ui.resume.addEventListener('change', reconsider);
  // Memory is part of the recipe a resume is compared against, and the headset moves it too.
  ui.memory.addEventListener('input', reconsider);
  // So are the authority, the noise and the cord: a resume lists how each differs from how the
  // checkpoint was trained, and the list should follow the slider rather than the next poll.
  for (const input of [
    ui.authority,
    ui.noiseMotor,
    ui.noiseSense,
    ui.spineStretch,
    ...REFLEX_REGIONS.map((r) => ui.spineRegions[r]),
    ui.spineVelocity,
    ui.spineSetPoint,
    ui.spineInhibition,
    ui.spineDelay,
  ]) {
    input.addEventListener('input', showRecipe);
  }

  /**
   * Every button on the tab, from the one set of rules the headset is sent as well.
   * @see brainButtons
   */
  const buttons = () =>
    brainButtons({
      serverUp,
      localRun: localRun !== undefined,
      localStopping,
      trainingRunning,
      trainingStoppable,
      elsewhere,
      selected: ui.policy.value,
      // A set-up waiting on its question is a hand-over's first half, and holds the button too.
      handingOver: handingOver || settingUp,
      policySet: setup !== undefined,
      // Not until the list has been read: a name cannot be judged against a list not yet seen.
      nameOk: rowsLoaded && nameAllowsStart(verdictOf(formRecipe()).verdict),
    });
  /** The chosen checkpoint's row, when the list has it. */
  const chosenRow = (): CheckpointRow | undefined => rows.find((r) => r.id === ui.policy.value);
  /**
   * Set up as trained, for a checkpoint that says how it was trained, and its Undo, for a set-up
   * there is to take back; neither while another is waiting on its question or a hand-over is
   * loading. Beside the rules `brainButtons` keeps, and sent to the headset beside them.
   */
  const setUpButtons = (): { canSetUp: boolean; canUndoSetUp: boolean } => {
    const busy = handingOver || settingUp;
    return {
      canSetUp: !busy && Boolean(chosenRow()?.recipe),
      canUndoSetUp: !busy && undoSetUp !== undefined,
    };
  };
  const setButtons = (): void => {
    const b = buttons();
    ui.start.disabled = !b.canStart;
    ui.stop.disabled = !b.canStop;
    ui.handover.disabled = !b.canHandOver;
    ui.release.disabled = !b.canRelease;
    const s = setUpButtons();
    ui.setUp.disabled = !s.canSetUp;
    ui.undoSetUp.disabled = !s.canUndoSetUp;
    const undoTitle = undoSetUp
      ? `Put the tabs and the training form back as they were before ${undoSetUp.name} was set up`
      : 'Nothing to undo: Set up as trained has not been used';
    if (ui.undoSetUp.title !== undoTitle) ui.undoSetUp.title = undoTitle;
    showForget();
  };

  /**
   * Forget, for a checkpoint this browser trained and holds. Only in a tab with no server: the
   * binary's checkpoints are files a terminal reads too, which the studio does not delete, and a
   * server's list is the server's. Not while the window is training it, whose next write would
   * bring it straight back, and not while it is the policy in the loop, which would leave the
   * panel naming a checkpoint that no longer exists as the one in charge.
   */
  const showForget = (): void => {
    const name = ui.policy.value;
    const offered = !holdsFilesOnDisk() && !serverUp && name !== '' && browserHeld.has(name);
    if (ui.forget.hidden === offered) ui.forget.hidden = !offered;
    const inUse =
      (localRun !== undefined && localRunName === name) ||
      (setup !== undefined && handedRow?.id === name) ||
      handingOver;
    ui.forget.disabled = !offered || inUse;
  };

  ui.forget.addEventListener('click', () => void forgetChosen());
  async function forgetChosen(): Promise<void> {
    const name = ui.policy.value;
    showForget();
    if (ui.forget.disabled || ui.forget.hidden) return;
    if (
      !(await askInPage(
        `Forget ${name}? Its record, its search centre and its history are deleted from this browser, and a Resume cannot continue it.`,
        'Forget it',
        'Keep it',
      ))
    ) {
      return;
    }
    ui.forget.disabled = true;
    await forgetBrowserCheckpoint(name);
    // Nothing is chosen now, rather than a choice the list will say went missing.
    ui.policy.value = '';
    chosenKey = '';
    chosenLost = false;
    // A poll already under way may have read the list before the delete; the one after it has not.
    if (polling) await polling;
    await poll();
    ui.policyNote.textContent = `Forgot ${name}. ${listNote()}`;
  }

  /**
   * The line under the list: where its checkpoints come from, and, in the binary with no server,
   * which files in the checkpoint folder were left out of it for not being checkpoints -- a file
   * a person copied in that did not appear used to be simply absent, with no word as to why.
   */
  const listNote = (lost = false): string => {
    const note = policyNote({
      serverUp,
      count: rows.length,
      filesOnDisk: holdsFilesOnDisk(),
      lost,
    });
    if (serverUp || skipped.length === 0) return note;
    const files = skipped.length === 1 ? '1 file' : `${skipped.length} files`;
    const are = skipped.length === 1 ? 'is not a checkpoint and is' : 'are not checkpoints and are';
    return `${note} ${files} in the checkpoint folder ${are} left out: ${skipped.join(', ')}.`;
  };

  const showRows = () => {
    // The same list as last time draws nothing. Rebuilding the <select> every poll closed it
    // under a person who had it open to choose from, three seconds at a time.
    const signature = `${serverUp}\n${skipped.join('\0')}\n${rows.map((r) => `${r.id}\0${describe(r)}`).join('\n')}`;
    if (signature === rowsSignature) {
      setButtons();
      return;
    }
    rowsSignature = signature;
    const chosen = ui.policy.value;
    ui.policy.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None';
    ui.policy.append(none);
    for (const row of rows) {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = describe(row);
      ui.policy.append(option);
    }
    // The same checkpoint in the new list, by name when its id is not there: a server that
    // starts or stops swaps one list for the other, and `policies/balance.json` is `balance`. No
    // 'change' is sent, because nothing was chosen.
    ui.policy.value = reselect(rows, chosen, chosenKey);
    chosenLost = chosenKey !== '' && ui.policy.value === '';
    showPolicyNote();
    setButtons();
  };

  /** The name a checkpoint goes by in what the panel says: the one it is saved under. */
  const nameOfRow = (row: CheckpointRow): string =>
    checkpointNameOf(row) ?? row.recipe?.name ?? row.name;
  /** Whether this panel can score a task, which is what putting it on the form needs. */
  const scorable = (task: string): boolean =>
    isTask(task) && [...ui.task.options].some((o) => o.value === task);

  /**
   * The line under the list. With nothing chosen, or the choice gone from the list, where the
   * list comes from. With a checkpoint chosen, how it differs from the tabs as they are now --
   * what Set up as trained, and Hand over before it hands over, would change -- worked out again
   * at every poll, so it follows the tabs as they are moved.
   */
  const choiceNote = (): string => {
    const row = chosenRow();
    if (!row) return listNote(chosenLost);
    const name = nameOfRow(row);
    const recipe = row.recipe;
    if (!recipe) {
      return (
        `${name} does not say what it was trained in, so there is nothing to set up: Hand over ` +
        'fits it to the body the tabs describe.'
      );
    }
    const unscored = scorable(recipe.task)
      ? ''
      : ` This panel cannot score '${recipe.task}', so setting it up leaves Scored on as it is, and a Resume of it would be refused.`;
    const change = host.recipeChange(recipe);
    if (change.differences.length === 0) return `The tabs are as ${name} was trained.${unscored}`;
    return (
      `${name} was trained with ${describeSetUpDifferences(change.differences)}. ` +
      `Set up as trained puts that on the tabs${change.restarts ? ' and restarts a run that is going' : ''}; ` +
      `Hand over does the same first.${unscored}`
    );
  };
  const showPolicyNote = (): void => {
    const text = choiceNote();
    if (ui.policyNote.textContent !== text) ui.policyNote.textContent = text;
  };

  /**
   * Choosing a checkpoint only shows it. Nothing on the tabs, the sliders or the training form
   * changes until Set up as trained or Hand over is pressed; the note says what they would change.
   */
  ui.policy.addEventListener('change', () => {
    chosenKey = ui.policy.value === '' ? '' : checkpointKey(ui.policy.value);
    chosenLost = false;
    showPolicyNote();
    setButtons();
  });

  /** The training form as it stands, for a set-up's Undo. */
  const formState = (): FormState => ({
    name: ui.name.value,
    nameTouched,
    task: ui.task.value,
    feedforward: ui.feedforward.value,
    noiseMotor: ui.noiseMotor.value,
    noiseSense: ui.noiseSense.value,
    memory: ui.memory.value,
  });

  /**
   * The training form as a checkpoint was trained.
   *
   * Its name, the one it is saved under, which is what Resume looks for, and marked as chosen so
   * the panel stops offering its own over it. A task this panel can score, and otherwise the one
   * on the form, rather than a stand, which made Resume continue a checkpoint on a score it never
   * learnt. The noise and the memory it was brought up with, so continuing it continues its
   * conditions; a checkpoint from before either existed was trained with the default noise and no
   * memory, and gets those.
   */
  const formOf = (row: CheckpointRow, recipe: TrainingRecipe): FormState => ({
    name: checkpointNameOf(row) ?? recipe.name,
    nameTouched: true,
    task: scorable(recipe.task) ? recipe.task : ui.task.value,
    feedforward: recipe.feedforward.kind,
    noiseMotor: String(recipe.noise?.motor ?? DEFAULT_NOISE.motor),
    noiseSense: String(recipe.noise?.sense ?? DEFAULT_NOISE.sense),
    memory: String(recipe.memory ?? 0),
  });

  /** Put a form on the panel, and tell its readouts and the recipe note. */
  const putForm = (form: FormState): void => {
    ui.name.value = form.name;
    nameTouched = form.nameTouched;
    ui.task.value = form.task;
    ui.feedforward.value = form.feedforward;
    ui.noiseMotor.value = form.noiseMotor;
    ui.noiseSense.value = form.noiseSense;
    ui.memory.value = form.memory;
    for (const input of [ui.noiseMotor, ui.noiseSense, ui.memory]) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    reconsider();
  };

  /**
   * Set the tabs and the form up as a checkpoint was trained, keeping what they were for Undo.
   * Synchronous, so a hand-over can put its policy in the panel's setup in the same turn: a run
   * this restarts is built a frame later, from that setup.
   */
  const setUpNow = (row: CheckpointRow, recipe: TrainingRecipe): SetUpEffect => {
    const form = formState();
    const { effect, undo } = host.applyRecipe(recipe);
    putForm(formOf(row, recipe));
    undoSetUp = { name: nameOfRow(row), form, tabs: undo };
    showPolicyNote();
    setButtons();
    return effect;
  };

  /**
   * Set up as trained. A function rather than a click, because the headset asks for it through
   * `act`. `ask` is for a press at the desktop, which asks before a restart throws a long
   * recording away; the headset's never does.
   */
  async function setUpChosen(ask: boolean): Promise<void> {
    const row = chosenRow();
    const recipe = row?.recipe;
    if (!row || !recipe || handingOver || settingUp) return;
    settingUp = true;
    setButtons();
    try {
      if (ask && host.recipeChange(recipe).restarts) {
        if (!(await host.confirmDiscard('Setting up as trained'))) return;
        // The list may have moved on while the question was open.
        if (ui.policy.value !== row.id) return;
      }
      setUpNow(row, recipe);
    } finally {
      settingUp = false;
      setButtons();
    }
  }

  /** Put back what the last set-up changed, once. A function for the same reason. */
  async function undoLastSetUp(ask: boolean): Promise<void> {
    const undo = undoSetUp;
    if (!undo || handingOver || settingUp) return;
    settingUp = true;
    setButtons();
    try {
      if (ask && undo.tabs.restarts() && !(await host.confirmDiscard('Undoing the set-up'))) {
        return;
      }
      if (undoSetUp !== undo) return;
      undoSetUp = undefined;
      undo.tabs.apply();
      putForm(undo.form);
      showPolicyNote();
    } finally {
      settingUp = false;
      setButtons();
    }
  }

  ui.setUp.addEventListener('click', () => void setUpChosen(true));
  ui.undoSetUp.addEventListener('click', () => void undoLastSetUp(true));

  /**
   * What the panel says of the body the checkpoint in the loop was trained in: nothing when it is
   * this one, one short sentence when it is not -- the first two differences and a count -- with
   * every difference in the tooltip. The nerves compare everything but the cord, which is the
   * spinal module's; the cord is compared here, against the sliders, which are what sets it.
   */
  const trainedBodyLine = (
    body: TrainedBody | undefined,
  ): { line: string; title: string } | undefined => {
    if (!body) return undefined;
    if (!body.recorded) {
      return {
        line: 'Trained before bodies were recorded.',
        title:
          'This checkpoint does not say which body it was trained in, so a change in what a sense ' +
          'means since then cannot be caught. It was fitted by the names of its senses and drives.',
      };
    }
    const saved = setup?.policy.body?.cord;
    const cord = saved ? compareCord(saved, reflexFromUi()) : undefined;
    const differences = cord ? [...body.differences, cord] : [...body.differences];
    if (differences.length === 0) return undefined;
    return {
      line: `Trained in a different body: ${summariseDifferences(differences)}.`,
      title: `Trained in a different body:\n${differences.map((d) => `- ${d}`).join('\n')}`,
    };
  };

  const showFit = () => {
    const fit = host.fit();
    if (!fit) {
      // Chosen and not in: say when it will be, and say plainly when it never will -- a run with
      // no muscles has nothing for a policy to drive, and "the next run" would be a promise the
      // next run does not keep unless something is changed first.
      ui.fitNote.textContent = !setup
        ? ''
        : host.musclesNextRun?.() === false
          ? 'Policy chosen, but the next run has no muscles for it to drive: tick Muscles or pick a muscle scene.'
          : fitPending === 'restart'
            ? 'Policy chosen; it goes in as the run restarts in the scene and body it was trained in.'
            : 'Policy chosen; it goes in with the next run.';
      ui.fitNote.title = '';
      // A showcase's brain is a brain in the loop, even though it is not this page's: the panel
      // draws it, so the idle note would be saying the opposite of what is on the screen.
      ui.idleNote.hidden = activity !== undefined;
      return;
    }
    ui.idleNote.hidden = true;
    // A shipped checkpoint trained in an older body carries only the part of itself that still
    // fits, and says so: the senses and drives it has no weights for are the ones the body
    // gained since, and the fitness in the list was scored without them.
    const shipped =
      handedRow?.origin === 'shipped' && handedRow.trainedBefore
        ? ` It shipped with the studio, trained before ${handedRow.trainedBefore}; its fitness was scored in that body.`
        : '';
    const body = trainedBodyLine(fit.carried.body);
    // A checkpoint trained with nothing under the brain runs with nothing under it: the host has
    // stopped the scenario's tone, and the body standing less well than it did a moment ago is
    // that rather than the policy failing.
    const tone =
      fit.scriptDrives === false
        ? " The scenario's muscle tone is off: this checkpoint learnt with nothing under it."
        : '';
    // The control period follows the policy on a hand-over; the timestep cannot, so a policy
    // handed into a run at another rate is evaluated as often as it was trained to be, on contacts
    // and muscle dynamics stepped differently from the ones it learnt on.
    const rate =
      fit.trainedRate !== undefined && fit.rate !== undefined && fit.trainedRate !== fit.rate
        ? ` Trained at ${fit.trainedRate} steps a second; this run is at ${fit.rate}, and the ` +
          `timestep cannot change live, so restart the run at ${fit.trainedRate} to match.`
        : '';
    ui.fitNote.textContent =
      `In the loop: ${fit.carried.inputs} of ${fit.inputs} senses and ` +
      `${fit.carried.outputs} of ${fit.outputs} drives carried from the checkpoint.${shipped}` +
      (body ? ` ${body.line}` : '') +
      tone +
      rate;
    ui.fitNote.title = body?.title ?? '';
  };

  /**
   * Ask the host to put a policy in, or take it out, and say why not when it would not. A host
   * that throws is refusing as much as one that answers with an error: either way the panel must
   * not go on to claim a policy the body never took.
   */
  const tryHandOver = (next: NervesSetup | undefined): HandOverResult => {
    try {
      return host.handOver(next);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const handOverRefused = (next: NervesSetup | undefined): string | undefined => {
    const result = tryHandOver(next);
    return typeof result === 'object' ? result.error : undefined;
  };

  /** The policy file for a checkpoint, from the server when there is one, else from this studio. */
  async function loadPolicy(id: string): Promise<NervesSetup['policy']> {
    // What this studio holds under the checkpoint's own name: the store it trains into, then the
    // set it shipped with. A server's search centre has no copy here, so it is not looked for.
    const held = async (): Promise<unknown> =>
      checkpointKey(id).startsWith('policy:')
        ? ((await readLocalCheckpoint(checkpointStem(id))) ??
          (await shippedCheckpoint(checkpointStem(id))))
        : undefined;
    if (serverUp) {
      try {
        const response = await fetch(`${dashboard}/policies/${encodeURIComponent(id)}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`${response.status}`);
        return (await response.json()) as NervesSetup['policy'];
      } catch (error) {
        // The server went away between the list and the press, most likely. The checkpoint may
        // well be here anyway, and a handover that could have worked should.
        const fallback = await held();
        if (fallback) return fallback as NervesSetup['policy'];
        throw error;
      }
    }
    const fallback = await held();
    if (!fallback) throw new Error(`this studio has no checkpoint called '${checkpointStem(id)}'`);
    return fallback as NervesSetup['policy'];
  }

  /**
   * Hand the chosen checkpoint over. A function rather than a click, because the headset asks for
   * it through `act`, and a button a stale status had disabled would swallow the click and say
   * nothing about it.
   *
   * When the tabs differ from how the checkpoint was trained, they are set up as it was trained
   * first, as Set up as trained would, with the same Undo: a policy only makes sense in the body
   * it learnt in. `ask` is for a press at the desktop, which asks before that set-up restarts a
   * run and throws a long recording away; the headset's press never waits on a question.
   */
  async function handOverChosen(ask: boolean): Promise<void> {
    const id = ui.policy.value;
    if (!id || handingOver || settingUp) return;
    handingOver = true;
    setButtons();
    try {
      const recipe = rows.find((r) => r.id === id)?.recipe ?? undefined;
      if (ask && recipe && host.recipeChange(recipe).restarts) {
        if (
          !(await host.confirmDiscard('Handing over, which sets the tabs up as it was trained,'))
        ) {
          return;
        }
      }
      const policy = await loadPolicy(id);
      // After the load and immediately before the hand-over, in the same turn: a set-up that
      // restarts the running body builds the new run a frame later, from the panel's setup,
      // which is assigned below before that frame comes. Asked again, because the tabs are the
      // person's to move while the checkpoint loads.
      const row = rows.find((r) => r.id === id);
      const restarted =
        row?.recipe && host.recipeChange(row.recipe).differences.length > 0
          ? setUpNow(row, row.recipe) === 'restarted'
          : false;
      const next: NervesSetup = {
        policy,
        // As the set-up left it: the authority the checkpoint was trained at, when it said.
        authority: Number(ui.authority.value),
        goal: 0,
        // No divisor: the run works it out from the rate it steps at and the one the checkpoint
        // was trained at (`controlDivisorFor`), live or at the next start, so the policy keeps its
        // trained control period. A tick count copied from the recipe would be the wrong period
        // at any other rate, and the panel does not know the rate a run will step at.
      };
      const result = tryHandOver(next);
      if (typeof result === 'object') {
        // Refused: the panel keeps what it had before rather than claiming the new one.
        ui.fitNote.textContent = `Could not put the policy in: ${result.error}`;
      } else {
        setup = next;
        handedRow = row;
        fitPending = result === 'deferred' ? (restarted ? 'restart' : 'next') : undefined;
        showFit();
      }
    } catch (error) {
      ui.fitNote.textContent = `Could not load the checkpoint: ${String(error)}`;
    } finally {
      handingOver = false;
      setButtons();
    }
  }

  /** Take the policy out of the loop; the run carries on. A function for the same reason. */
  function releasePolicy(): void {
    setup = undefined;
    handedRow = undefined;
    fitPending = undefined;
    // Taking a policy out of a run that has none leaves it out, so there is nothing to report.
    handOverRefused(undefined);
    ui.fitNote.textContent = '';
    ui.fitNote.title = '';
    ui.idleNote.hidden = false;
    setButtons();
  }

  ui.handover.addEventListener('click', () => void handOverChosen(true));
  ui.release.addEventListener('click', releasePolicy);
  ui.authority.addEventListener('change', () => {
    if (!setup) return;
    const next = { ...setup, authority: Number(ui.authority.value) };
    const why = handOverRefused(next);
    // A refusal here used to reach the console alone, and the panel went on showing an
    // authority the body was not running at.
    if (why !== undefined) ui.fitNote.textContent = `Could not change the authority: ${why}`;
    else setup = next;
  });

  // The key's swatches take the lines' own colours, from the constants the lines are drawn in.
  for (const swatch of ui.chartKey.querySelectorAll<HTMLElement>('.swatch')) {
    swatch.style.background = swatch.dataset.series === 'best' ? BEST_COLOUR : MEAN_COLOUR;
  }

  /**
   * The run's history: the best of each generation and the population's mean, on an axis that
   * goes below zero when a line does. Labelled with the top and the bottom of that axis and the
   * generations it covers, with a key under it that shows whether notes are on or not, because a
   * chart of two unnamed lines and one number could not be read.
   * @see chartScale
   */
  const drawSeries = (series: readonly (readonly [number, number, number, number])[]) => {
    ui.chart.hidden = series.length < 2;
    ui.chartKey.hidden = ui.chart.hidden;
    if (ui.chart.hidden) return;
    ui.chart.setAttribute('aria-label', chartDescription(series));
    const context = ui.chart.getContext('2d');
    if (!context) return;
    const { width, height } = ui.chart;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#14161a';
    context.fillRect(0, 0, width, height);
    const scale = chartScale(series);
    const x = (i: number) => chartX(i, series.length, width);
    const y = (v: number) => chartY(v, scale, height);
    if (scale.floor < 0) {
      // Zero, faintly, once the axis goes under it: above the line is a body scoring for being
      // up, below it one losing more than it earns.
      context.strokeStyle = '#2a2f38';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, Math.round(y(0)) + 0.5);
      context.lineTo(width, Math.round(y(0)) + 0.5);
      context.stroke();
    }
    const line = (
      pick: (row: readonly [number, number, number, number]) => number,
      colour: string,
    ) => {
      context.strokeStyle = colour;
      context.lineWidth = 1.2;
      context.beginPath();
      series.forEach((row, i) => {
        if (i === 0) context.moveTo(x(i), y(pick(row)));
        else context.lineTo(x(i), y(pick(row)));
      });
      context.stroke();
    };
    line((row) => row[2], BEST_COLOUR);
    line((row) => row[1], MEAN_COLOUR);
    context.fillStyle = '#6b7280';
    context.font = '10px ui-monospace, monospace';
    context.textAlign = 'left';
    context.fillText(scale.top.toFixed(2), 4, 11);
    context.fillText(scale.floor.toFixed(2), 4, height - 4);
    context.textAlign = 'right';
    context.fillText(generationRange(series), width - 4, height - 4);
    context.textAlign = 'left';
  };

  const drawChart = (status: TrainingStatus) => {
    drawSeries(status.latest?.series ?? []);
  };

  /**
   * The one painter of a run in this window: what it last said, how far the generation under way
   * has got, whether it is saving, and whether it has been asked to stop -- then its chart. Every
   * callback and the poll come through here, so none of them can write a line that leaves out
   * what another has said. The Stop acknowledgement in particular: once Stop has been asked for,
   * it is said and kept said. A generation takes seconds, and a line that replaced the
   * acknowledgement made the button look like it had done nothing, which is the one thing a Stop
   * button must never look like.
   */
  const paintLocal = (): void => {
    const saving =
      localSaveProblem !== '' && !localStatus.includes(localSaveProblem)
        ? ` — not saving: ${localSaveProblem}`
        : '';
    ui.status.textContent =
      localStatus +
      (localProgress ? ` — ${localProgress}` : '') +
      saving +
      (localStopping ? ' — stopping after this generation.' : '');
    drawSeries(localSeries);
  };

  const showStatus = (status: TrainingStatus | undefined) => {
    trainingRunning = status?.running === true;
    // The dashboard keeps the last run's name after the run ends, so the status line can name the
    // record it shows. That name is what a Start's note is about; it is not whose brain is on the
    // bridge once the run has ended -- `serverRun` is that, and only while there is one.
    trainingName = status?.name ?? undefined;
    serverRun = activitySource(status, undefined);
    // The showcase that plays the run keeps publishing after the trainer has gone, and the studio
    // goes on following it, so Stop stays offered while there is anything left to stop.
    trainingStoppable = trainingRunning || status?.showcase === true;
    elsewhere = status?.elsewhere === true;
    setButtons();
    if (!status) {
      if (refusal) {
        ui.status.textContent = refusal;
        return;
      }
      // A run here, or one that has just ended, is the news: the poll every few seconds used to
      // write the bare status over the progress, the Stop acknowledgement and the chart, which
      // then flickered away until the next generation drew them back.
      if (localRun || localStatus !== '' || localSeries.length > 0) {
        paintLocal();
        return;
      }
      // Without a server the panel trains here instead, so it says that rather than refusing,
      // with the number of workers a run would really make.
      ui.status.textContent =
        `No dashboard server: Start trains in this window, in ${workersHere(Number(ui.workers.value))} workers, ` +
        (holdsFilesOnDisk()
          ? 'saving to the data folder. A terminal server uses every core.'
          : 'saving to this browser. A terminal server is faster and writes real files.');
      ui.chart.hidden = true;
      ui.chartKey.hidden = true;
      return;
    }
    // A run in this window goes on when a server appears, and it is still the run this window is
    // training: its line stays, rather than the server's account of a run it knows nothing about.
    if (localRun) {
      paintLocal();
      return;
    }
    // A refusal is news about the button just pressed; the run's own status is not, and must
    // not paint over it.
    if (refusal) {
      ui.status.textContent = refusal;
      drawChart(status);
      return;
    }
    // Said first when the trainer stopped by itself with an error, here and so on the headset,
    // whose training line is this one: a run that died on start used to leave "Not training.
    // Last run: ..." about some earlier run, and the reason in a terminal nobody was watching.
    const line = trainingStatusLine(status);
    const about = startNote !== '' && trainingName !== undefined && trainingName === startNoteFor;
    ui.status.textContent = about ? `${line} ${startNote}` : line;
    drawChart(status);
  };

  /**
   * Start and stop are functions, not clicks: the headset asks for them through `act`, and a
   * button disabled by a status the desktop has not polled since would swallow the click.
   */
  async function startTraining(ask: boolean): Promise<void> {
    // The name first, before either path: a name the note refuses is refused here, whichever
    // way Start was pressed, and nothing is fetched, spawned or written for it.
    const resolved = recipeFromUi();
    if ('error' in resolved) {
      refusal = `Could not start: ${resolved.error}`;
      ui.status.textContent = refusal;
      setButtons();
      return;
    }
    const { recipe } = resolved;
    // A run on the dashboard is followed as it starts, which throws this page's own run away, so
    // a press at the desktop asks first when that run has a long recording. The headset's Start
    // does not wait on a question it cannot see.
    if (ask && serverUp && !host.following()) {
      if (!(await host.confirmDiscard('Starting training, which follows its showcase,'))) return;
    }
    ui.start.disabled = true;
    startNote = '';
    startNoteFor = undefined;
    // No server: the search runs here, in web workers, saving to this window's own store. The
    // dashboard is still better from a terminal -- every core, and real files -- so it wins
    // when it is there.
    if (!serverUp) {
      await startTrainingHere(recipe);
      return;
    }
    try {
      const response = await fetch(`${dashboard}/train/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The dashboard's `recipeFrom` reads the authority, the task and the name from the top
        // of the request rather than from inside the recipe -- that is where the studio has
        // always sent them -- so they go there, from the one recipe, and cannot disagree with it.
        body: JSON.stringify({
          task: recipe.task,
          name: recipe.name,
          authority: recipe.authority,
          recipe,
          generations: Number(ui.generations.value),
          population: Number(ui.population.value),
          seconds: Number(ui.seconds.value),
          workers: Number(ui.workers.value),
          seeds: SEARCH_DEFAULTS.seeds,
          resume: ui.resume.checked,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        name?: string;
        clamped?: readonly Adjusted[];
        recipeChanges?: string;
      };
      if (result.error) {
        refusal = `Could not start: ${result.error}`;
      } else {
        refusal = '';
        // What the server did with what it was sent, which a person cannot see otherwise: a
        // value it held to its limits trains a body the sliders do not show, and a resumed
        // checkpoint trains under the recipe sent, not the one it was saved with.
        const name = result.name ?? recipe.name;
        const adjusted = adjustedPhrase(result.clamped);
        startNote = [
          adjusted ? `Started; ${adjusted}.` : '',
          result.recipeChanges ? `Resuming ${name} with changes: ${result.recipeChanges}.` : '',
        ]
          .filter((part) => part !== '')
          .join(' ');
        startNoteFor = name;
        if (startNote !== '') ui.status.textContent = startNote;
        if (!host.following()) host.startFollowing();
      }
    } catch (error) {
      refusal = `Could not start: ${String(error)}`;
    }
    await poll();
  }

  /** Refuse a Start in this window, and say why until something is done about it. */
  const refuseHere = (why: string): void => {
    refusal = `Could not start: ${why}`;
    ui.status.textContent = refusal;
    setButtons();
  };

  /**
   * Train in this window: no fetch, no server, nothing spawned. `recipe` is the one the resolver
   * gave, whose name has passed the rule; what is checked here is what only the store can say.
   */
  async function startTrainingHere(recipe: TrainingRecipe): Promise<void> {
    if (localRun) return;
    const wanted = recipe.name;
    // The same rules the server keeps, asked of the store itself rather than of the list, which
    // may be a poll behind it. A name that exists is refused unless Resume is ticked: without
    // this a second run under an old name would overwrite the checkpoint it took an afternoon to
    // train, and say nothing about it.
    const saved = (await readLocalCheckpoint(wanted)) as PolicyFile | undefined;
    if (!ui.resume.checked && saved) {
      refuseHere(
        `a checkpoint named ${wanted} exists; tick Resume to continue it, or choose another name`,
      );
      return;
    }
    if (ui.resume.checked) {
      // And a Resume with nothing to continue is refused rather than started afresh under a word
      // that said otherwise, which is what the trainer does when it finds nothing saved.
      const held =
        saved ?? ((await createCheckpointStore(wanted).read('centre')) as PolicyFile | undefined);
      if (!held) {
        refuseHere(`nothing saved under ${wanted} to continue. Untick Resume to start it`);
        return;
      }
      if (typeof held.task === 'string' && held.task !== recipe.task) {
        refuseHere(
          `${wanted} was trained on ${held.task}; Resume continues only the same task. Choose another name`,
        );
        return;
      }
    }
    refusal = '';
    localSeries = [];
    localProgress = '';
    localSaveProblem = '';
    localRunName = wanted;
    const workers = workersHere(Number(ui.workers.value));
    localStatus = `Building bodies: 0 of ${workers} ready`;
    paintLocal();
    localRun = startLocalTraining({
      recipe,
      generations: Number(ui.generations.value),
      population: Number(ui.population.value),
      seconds: Number(ui.seconds.value),
      workers,
      seeds: SEARCH_DEFAULTS.seeds,
      resume: ui.resume.checked,
      // A body a worker, and each takes seconds to build, so the count is said as it goes.
      onReady: (ready, total) => {
        localStatus = `Building bodies: ${ready} of ${total} ready`;
        paintLocal();
      },
      onNote: (text) => {
        localStatus = text.trim();
        paintLocal();
      },
      onProgress: ({ generation, done, total, centre }) => {
        localProgress = centre
          ? `generation ${generation}: scoring the centre`
          : `generation ${generation}: ${done} of ${total} episodes`;
        paintLocal();
      },
      onSaveFailed: (message) => {
        localSaveProblem = message;
        paintLocal();
      },
      onGeneration: (report) => {
        localSeries.push([
          report.generation,
          Number(report.mean.toFixed(4)),
          Number(report.top.toFixed(4)),
          Number(report.topAlive.toFixed(3)),
        ]);
        localProgress = '';
        localStatus =
          // How far along, and about how long is left, as the terminal and the dashboard say it,
          // and how long this generation's episodes took, which is what the Population and
          // Episode seconds sliders cost.
          `Training ${runLabel(recipe.name, recipe.task)} here: ` +
          `${progressPhrase({ ...report, state: 'running' })}, ` +
          `mean ${report.mean.toFixed(3)}, top ${report.top.toFixed(3)} ` +
          `(${report.topAlive.toFixed(2)} s up)${report.note}, ${report.seconds.toFixed(0)} s`;
        paintLocal();
      },
      onDone: (summary) => {
        localRun = undefined;
        localRunName = undefined;
        localStopping = false;
        localProgress = '';
        localStatus = summary;
        paintLocal();
        setButtons();
        // The run saved a checkpoint, and the list should have it now rather than at the next
        // poll -- which, with the Brain tab closed and no headset asking, may be never.
        void poll();
      },
      onError: (message) => {
        localRun = undefined;
        localRunName = undefined;
        localStopping = false;
        localProgress = '';
        localStatus = `Could not train here: ${message}`;
        paintLocal();
        setButtons();
      },
    });
    setButtons();
  }

  async function stopTraining(): Promise<void> {
    startNote = '';
    startNoteFor = undefined;
    if (localRun) {
      localRun.stop();
      localStopping = true;
      paintLocal();
      ui.stop.disabled = true;
      return;
    }
    ui.stop.disabled = true;
    try {
      await fetch(`${dashboard}/train/stop`, { method: 'POST' });
    } catch {
      // The status poll says what happened.
    }
    await poll();
  }

  ui.start.addEventListener('click', () => void startTraining(true));
  ui.stop.addEventListener('click', () => void stopTraining());

  /**
   * The showcase's brain, ten times a second while there is one to watch.
   *
   * Its own poll rather than the status one's: the status is a second or three apart, which is a
   * slideshow, and the activity file is small and rewritten at ten hertz. Which checkpoint's file
   * to read comes from the server while its run is up, and otherwise from the name the showcase
   * puts in the bridge status, so a run started in a terminal is watched too.
   *
   * Only while somebody can see it. This used to run from the moment the page opened for as long
   * as it stayed open -- ten requests a second, whichever tab was showing, for a canvas on one of
   * them -- and went on reading a finished run's file, because the dashboard keeps the last run's
   * name.
   */
  /** A showcase that has stopped leaves its last file behind; this long unchanged is gone. */
  const ACTIVITY_STALE_MS = 3000;
  /**
   * How long to wait before looking again when there is nothing live to draw: a file that is
   * missing or has stopped changing, and no server run about to write one. A showcase started from
   * a terminal is still found within a second; nothing is asked ten times a second to learn that.
   */
  const ACTIVITY_IDLE_MS = 1000;
  let activityInFlight = false;
  let nextActivityAt = 0;
  /**
   * Whether the brain is on screen: the host's answer when it gives one, else the Activity canvas
   * in a tab that is open, in a section that is not folded away, in a page that is not hidden.
   * Looked up each time rather than once, because the tabs are the host's to rearrange.
   */
  const watchingBrain = (): boolean => {
    if (document.visibilityState === 'hidden') return false;
    const asked = host.watchingBrain?.();
    if (asked !== undefined) return asked;
    const canvas = document.querySelector('#nerves-activity');
    if (!canvas) return false;
    const panel = canvas.closest<HTMLElement>('[data-panel]');
    return panel?.hidden !== true && canvas.closest('details:not([open])') === null;
  };
  const pollActivity = async (): Promise<void> => {
    const name = serverRun ?? publishedName ?? host.publishedTrainingName();
    if (!serverUp || !name || !watchingBrain()) {
      activity = undefined;
      return;
    }
    if (activityInFlight || performance.now() < nextActivityAt) return;
    activityInFlight = true;
    try {
      const response = await fetch(`${dashboard}/runs/${encodeURIComponent(name)}-activity.json`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const fresh = (await response.json()) as Omit<RemoteActivity, 'name'>;
      if (!Array.isArray(fresh.layers) || fresh.layers.length === 0) throw new Error('no layers');
      const now = performance.now();
      // Against what was last read rather than what is being shown: a stale file cleared and
      // then read again would otherwise look like a change every time and flicker back on.
      const seen = `${fresh.generation}:${fresh.time}`;
      if (seen !== activitySeen) {
        activitySeen = seen;
        activityChangedAt = now;
      }
      // Between episodes the showcase rests a moment, so the file is allowed to stand still for
      // a few seconds; longer than that and nobody is writing it.
      activity = now - activityChangedAt > ACTIVITY_STALE_MS ? undefined : { ...fresh, name };
    } catch {
      // No showcase, or a file caught between writes: nothing to draw.
      activity = undefined;
    } finally {
      activityInFlight = false;
      // A server run that is up is writing, or about to; anything else is asked again in a second
      // rather than a tenth of one.
      nextActivityAt =
        activity === undefined && serverRun === undefined
          ? performance.now() + ACTIVITY_IDLE_MS
          : 0;
    }
  };
  window.setInterval(() => {
    void pollActivity();
    // A policy waiting for a run says it is in as soon as one takes it: a set-up's restart lands
    // a compile later, and a Start whenever somebody presses it. Nothing else would say so until
    // the next poll, and none comes while the Brain tab is shut and no headset is asking.
    if (fitPending !== undefined && host.fit() !== undefined) {
      fitPending = undefined;
      showFit();
    }
  }, 100);

  /** The checkpoints this studio holds itself, in the shape the list draws. */
  async function localRows(): Promise<CheckpointRow[]> {
    // What this studio trained itself, and what it shipped with. A name trained here wins: a
    // person who has retrained `balance` means the one they retrained.
    const listed = await listLocalCheckpoints();
    const held = listed.rows;
    skipped = listed.skipped;
    const mine = new Set(held.map((row) => row.name));
    // What Forget may delete: this browser's own store, never the binary's folder.
    browserHeld = holdsFilesOnDisk() ? new Set() : mine;
    const shipped = (await shippedCheckpoints()).filter((row) => !mine.has(row.name));
    const row = (name: string, file: unknown, origin: 'shipped' | 'local'): CheckpointRow => {
      const policy = file as PolicyFile;
      const before = origin === 'shipped' ? trainedBefore(policy) : undefined;
      return {
        id: name,
        name,
        task: policy.task ?? 'stand',
        profile: policy.profile ?? null,
        sizes: policy.sizes ?? [],
        trained: policy.trained ?? null,
        recipe: (policy.recipe as TrainingRecipe | undefined) ?? null,
        origin,
        ...(before ? { trainedBefore: before } : {}),
      };
    };
    return [
      ...held.map(({ name, file }) => row(name, file, 'local')),
      ...shipped.map(({ name, file }) => row(name, file, 'shipped')),
    ];
  }

  /**
   * A server's list with the shipped checkpoints it was seeded with marked as shipped. The server
   * copies the repository's policies into its data folder once and lists them as files like any
   * other, so a file is taken to be the shipped one when it has a shipped name and was trained at
   * the same moment; one retrained since under the same name is somebody's own.
   */
  async function markShipped(served: readonly CheckpointRow[]): Promise<CheckpointRow[]> {
    const shipped = await shippedCheckpoints();
    return served.map((row) => {
      const name = checkpointNameOf(row);
      const twin = shipped.find(
        (s) =>
          s.name === name &&
          s.file.trained?.at !== undefined &&
          s.file.trained.at === row.trained?.at,
      );
      if (!twin) return row;
      const before = trainedBefore(twin.file);
      return { ...row, origin: 'shipped', ...(before ? { trainedBefore: before } : {}) };
    });
  }

  /**
   * The list, as read, and the name the form offers once there is a list to offer it against:
   * the task, or the task with the first free number after it, so the first Start is never
   * refused for a name the studio ships with and never continues one nobody chose.
   */
  const takeRows = (next: CheckpointRow[]): void => {
    rows = next;
    if (!rowsLoaded) {
      rowsLoaded = true;
      if (!nameTouched) ui.name.value = freeCheckpointName(rows, ui.task.value);
    }
  };

  // Until the first poll answers, the list is not known either way; the page's own note used to
  // say there was no server before anything had been asked.
  ui.policyNote.textContent = 'Looking for checkpoints…';
  setButtons();

  /** The first wait after a server did not answer, and the longest it grows to. */
  const PROBE_FIRST_MS = 3000;
  const PROBE_LONGEST_MS = 60_000;
  /** Ask the server again at the next poll, whatever the wait had grown to. */
  const wake = (): void => {
    probeDelayMs = 0;
    nextProbeAt = 0;
    void poll();
  };
  // Opening the Brain tab is a person looking for the server's list, so it is asked for at once
  // rather than at the end of a wait that may have grown to a minute. The tab is watched here
  // rather than told about, because the tab strip knows nothing of what its panels poll.
  const section = ui.policy.closest<HTMLElement>('[data-panel]');
  if (section && typeof MutationObserver !== 'undefined') {
    let wasHidden = section.hidden;
    new MutationObserver(() => {
      if (wasHidden && !section.hidden) wake();
      wasHidden = section.hidden;
    }).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  }

  /** The poll going now, which a second caller waits on rather than starting another beside it. */
  let polling: Promise<void> | undefined;
  function poll(): Promise<void> {
    polling ??= pollOnce().finally(() => {
      polling = undefined;
    });
    return polling;
  }

  async function pollOnce(): Promise<void> {
    let served: [{ policies: CheckpointRow[] }, TrainingStatus] | undefined;
    if (serverUp || performance.now() >= nextProbeAt) {
      try {
        served = await Promise.all([
          fetch(`${dashboard}/policies`, { cache: 'no-store' }).then(
            (r) => r.json() as Promise<{ policies: CheckpointRow[] }>,
          ),
          fetch(`${dashboard}/train/status`, { cache: 'no-store' }).then(
            (r) => r.json() as Promise<TrainingStatus>,
          ),
        ]);
        probeDelayMs = 0;
      } catch {
        probeDelayMs =
          probeDelayMs === 0 ? PROBE_FIRST_MS : Math.min(probeDelayMs * 2, PROBE_LONGEST_MS);
        nextProbeAt = performance.now() + probeDelayMs;
      }
    }
    if (served) {
      const [policies, status] = served;
      serverUp = true;
      skipped = [];
      browserHeld = new Set();
      takeRows(await markShipped(policies.policies));
      showRows();
      showStatus(status);
      // Who is on the bridge, when this server is not the one training: the showcase names the
      // checkpoint it is playing, and that is the run file to read the brain from.
      if (!serverRun) {
        try {
          const bridge = await fetch(`${dashboard}/bridge/status`, { cache: 'no-store' });
          const played = bridge.ok
            ? ((await bridge.json()) as { training?: { task?: string } }).training?.task
            : undefined;
          publishedName = typeof played === 'string' && played !== '' ? played : undefined;
        } catch {
          publishedName = undefined;
        }
      } else {
        publishedName = undefined;
      }
    } else {
      // No server, or none asked this time. The studio still has whatever it trained itself --
      // files in the binary, this browser's own store in a tab -- and what it shipped with, and
      // those are checkpoints like any other, so they go in the list rather than the list going
      // empty.
      serverUp = false;
      takeRows(await localRows());
      showRows();
      showStatus(undefined);
    }
    showFit();
    showRecipe();
    // How the chosen checkpoint differs from the tabs, which may have been moved since.
    showPolicyNote();
    // Whether the readout says what a run here would do depends on whether there is a server.
    showWorkers();
  }

  return {
    poll,
    get setup() {
      return setup;
    },
    remoteActivity() {
      return activity;
    },
    state() {
      return {
        serverUp,
        active: host.fit() !== undefined,
        authority: Number(ui.authority.value),
        selected: ui.policy.value,
        checkpoints: rows.map((r) => ({ id: r.id, name: describe(r) })),
        fit: ui.fitNote.textContent ?? '',
        training: ui.status.textContent ?? '',
        trainingRunning,
        trainingStoppable,
        following: host.following(),
        reflex: {
          stretch: Number(ui.spineStretch.value),
          velocity: Number(ui.spineVelocity.value),
          setPoint: Number(ui.spineSetPoint.value),
          inhibition: Number(ui.spineInhibition.value),
          delaySeconds: Number(ui.spineDelay.value),
          regionStretch: regionsFromUi(),
        },
        memory: Number(ui.memory.value),
        canStart: !ui.start.disabled,
        canStop: !ui.stop.disabled,
        canHandOver: !ui.handover.disabled,
        canRelease: !ui.release.disabled,
        canSetUp: !ui.setUp.disabled,
        canUndoSetUp: !ui.undoSetUp.disabled,
        policyNote: ui.policyNote.textContent ?? '',
        spineNote: `${spineNote(reflexFromUi())} ${trainingCordNote(reflexFromUi())}`,
      };
    },
    reflex: reflexFromUi,
    act(action, id, value) {
      switch (action) {
        case 'select':
          // Only shows it, as on the desktop.
          ui.policy.value = id ?? '';
          ui.policy.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        // The headset's presses never ask: a question would open on the desktop's screen, which
        // the person in the headset cannot see, and the button would do nothing they could see.
        case 'setup':
          void setUpChosen(false);
          break;
        case 'undoSetup':
          void undoLastSetUp(false);
          break;
        case 'handover':
          if (id !== undefined) {
            ui.policy.value = id;
            ui.policy.dispatchEvent(new Event('change', { bubbles: true }));
          }
          // The function, not the button: see handOverChosen.
          void handOverChosen(false);
          break;
        case 'release':
          releasePolicy();
          break;
        case 'authority':
          ui.authority.value = String(value ?? Number(ui.authority.value));
          ui.authority.dispatchEvent(new Event('input', { bubbles: true }));
          ui.authority.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        case 'trainStart':
          void startTraining(false);
          break;
        case 'trainStop':
          void stopTraining();
          break;
        case 'follow':
          host.toggleFollowing();
          break;
        // The cord and the memory: the headset moves the desktop's own sliders, so there is one
        // place the value lives and both panels read it back the same way.
        case 'reflexStretch':
        case 'reflexVelocity':
        case 'reflexSetPoint':
        case 'reflexInhibition':
        case 'reflexDelay':
        case 'memory': {
          const input = {
            reflexStretch: ui.spineStretch,
            reflexVelocity: ui.spineVelocity,
            reflexSetPoint: ui.spineSetPoint,
            reflexInhibition: ui.spineInhibition,
            reflexDelay: ui.spineDelay,
            memory: ui.memory,
          }[action];
          if (value !== undefined) input.value = String(value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
        case 'reflexRegionStretch': {
          const region = REFLEX_REGIONS.find((r) => r === id);
          if (!region) break;
          const input = ui.spineRegions[region];
          if (value !== undefined) input.value = String(value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
        default:
          break;
      }
    },
  };
}
