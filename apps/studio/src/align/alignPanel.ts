/**
 * The Align tab: bring the two bodies into register, decide which muscle is which, and move the
 * points of ours that are wrong.
 *
 * Three jobs that share a viewport, because they are the same act of looking. The reference model
 * has to be placed before anything on it can be compared; the comparison is what the pairing is
 * made from; and a point that turns out to be misplaced is found the same way, by looking at it
 * against the bone it sits on.
 *
 * What comes out is three files, each carrying the body and the reference data it was made
 * against (`provenance.ts`): a correspondence mapping, a bone pairing whose rows say whether a
 * person or a name match decided them, and a set of point overrides that record how far each
 * point moved and why. Each can be opened back in, and a reload keeps them as a draft.
 *
 * They are proposals for a person to review, and nothing in the build reads them yet. Item 1.7 of
 * `docs/plans/dataset-correspondence.md` is where the correspondence gets its reader, in
 * `measure:source-travel`, and that reader must take a committed file: CI runs
 * `measure:source-travel --check`, and a download lands wherever the browser puts it, which is no
 * place a build can depend on.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type { CompiledMuscleSet } from '@bs-humany/modules-muscle';
import type { Camera, WebGLRenderer } from 'three';
import { MathUtils, Object3D, type Vector3 } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DRAG_THRESHOLD } from '../orbit.js';
import { keyOwnedByTarget } from '../shortcuts.js';
import { createMemory } from '../ui/memory.js';
import { TAB_CHANGE } from '../ui/tabs.js';
import {
  type MergeReport,
  type StampedBonePair,
  bonePairingDocument,
  correspondenceDocument,
  describeMerge,
  mergeBonePairs,
  mergeMoves,
  mergePairs,
  overridesDocument,
  readAlignmentFile,
  readDraft,
  serialise,
  writeDraft,
} from './alignmentFiles.js';
import { type Pair, missingSegments, pairLabel, pairedIn, unpairAt } from './correspondence.js';
import { describeFits } from './fit.js';
import { type Seat, seatReferenceModel, viaPoints } from './ourBody.js';
import {
  type Handle,
  type HandleKind,
  KEPT_MATCH,
  type Move,
  PointHandles,
} from './pointHandles.js';
import { type BodyStamp, type SourceSitesStamp, fnv1a32 } from './provenance.js';
import { fitBodies, fittedFromPlacement, retargetPath, suggestBodyPairs } from './retarget.js';
import {
  type MeshCount,
  NEUTRAL as NEUTRAL_PLACEMENT,
  type Placement,
  SourceOverlay,
  type SourceSites,
} from './sourceOverlay.js';

export type { Pair } from './correspondence.js';

export interface AlignHost {
  /** The compiled body as it stands, or undefined before a run is built. */
  articulation(): CompiledArticulation | undefined;
  /** Our muscle unit ids, for the right-hand list. */
  units(): readonly string[];
  /**
   * Our joints touching a segment: where each sits at rest, and the segment on the other side.
   *
   * The other side is what lets a joint of theirs be matched to one of ours -- both models agree
   * a hip is a hip, so the joint between two paired bones is the same joint in both. The pure
   * answer is `jointsOnSegment` in `ourBody.ts`, which a host can hand straight through.
   */
  jointsOn(segment: string): readonly {
    at: import('three').Vector3;
    other: string;
    /**
     * The joint's own hinge axes in the world. Nothing reads them any more: settling a bone's
     * roll by them measured worse than inheriting it (see `fit.ts`). They stay in the shape until
     * the host hands `jointsOnSegment` through.
     */
    axes: import('three').Vector3[];
  }[];
  /**
   * Attachment sites in the world at rest; `attachmentSites` in `ourBody.ts` is the pure answer.
   * `segment`, when given, is the segment carrying the site's bone.
   */
  sites(): readonly {
    id: string;
    bone: string;
    segment?: string;
    world: { x: number; y: number; z: number };
  }[];
  /** Light up one of our segments in the viewport, or clear it with undefined. */
  highlightSegment(id: string | undefined): void;
  /**
   * Hand a file to the user through the studio's saving helper, which reports it in the status
   * line like every other export. True once it is written; false when it was cancelled or failed,
   * which the helper has already said.
   */
  save(name: string, text: string): Promise<boolean>;
  /** Ask for a JSON file to open, however this studio asks; its text, or undefined if none. */
  open(): Promise<string | undefined>;
  /** Our compiled muscle set, for the via points, or undefined before a run is built. */
  muscles(): CompiledMuscleSet | undefined;
  /**
   * Hold the body at rest while our points are shown, or let it go.
   *
   * Points are defined and recorded at rest, so a point is only judged fairly against its bone
   * when the bone is at rest too. The host pauses a live run to do it and never resumes one.
   */
  holdRest(on: boolean): void;
  /** The body a saved file was made against: the running one's profile and morphology. */
  body(): BodyStamp | undefined;
  /**
   * Whether a gizmo is mid-drag, asked by the orbit controls before they take a pointer.
   *
   * The camera must hold still while a handle is being dragged, and three's gizmo says when that
   * is happening through its own `dragging-changed` event.
   */
  setGizmoDragging(dragging: boolean): void;
}

const must = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

export interface AlignPanel {
  /**
   * Whether the pointer is over a gizmo handle right now.
   *
   * Asked by the orbit controls before they take a press. It has to be the *hover* state and not
   * the dragging one: three sets `dragging` inside its own pointerdown, which runs after the
   * camera has already been offered the same press, so a drag that has started is too late to
   * ask about. `axis` is set on hover and is the question that can be answered in time.
   */
  overGizmo(): boolean;
  /**
   * Pick the point of ours drawn under a place on the page, if there is one to pick.
   *
   * Only while the tab is open, the handles are showing and the gizmo is neither hovered nor
   * dragged -- a press on the gizmo is the gizmo's. True when a point was picked, so a caller
   * that also picks things on a click knows this one is spent. The panel runs it on its own
   * clicks; it is public for a caller that would rather order the picks itself.
   */
  pickPoint(clientX: number, clientY: number): boolean;
  /**
   * Switch every Align tool on or off: the gizmo, the handles, the reference overlay, the tinted
   * segment and point picking.
   *
   * They draw into the viewport every tab shares, and they belong to this tab. Left on elsewhere,
   * the gizmo takes presses meant for the camera, the handles take clicks meant for the bones,
   * and the overlay clutters a view that no longer explains it. Switching off remembers what the
   * gizmo was holding and switching on gives it back, so leaving the tab and returning loses
   * nothing. The panel follows the tabs by itself (see `TAB_CHANGE`); this is for a caller that
   * would rather say so.
   */
  setActive(active: boolean): void;
  /** Add the overlay and the handles to a scene graph. */
  attach(world: Object3D): void;
  /**
   * Take the reference sites once they have been fetched. The panel fetches them itself the first
   * time the tab opens; taking the same data twice does nothing.
   */
  adopt(data: SourceSites): void;
  /** Say the reference sites could not be loaded, and why, and shut the model list. */
  unavailable(reason: string): void;
  /** Called when the body is rebuilt, so the handles follow it. */
  refresh(): void;
  dispose(): void;
}

/** What the gizmo holds: nothing, the whole reference model, or the picked point of ours. */
type GizmoTarget = 'off' | 'model' | 'point';
/** Moving or turning. Scaling is left out: a placement has one uniform scale, and its slider. */
type GizmoMode = 'translate' | 'rotate';

/** What a control that needs a body says before there is one. */
const START_NOTE =
  'Our segments and units appear once a run has started: press ▶ Start sim in the top bar.';
/** What Our points says when a kind is chosen and there is no body to read it from. */
const POINTS_NEED_BODY =
  'Joint centres and attachment sites are read from a running body: press ▶ Start sim in the ' +
  'top bar.';
/**
 * Why a reference model's bone meshes are missing, when some are.
 *
 * The meshes are served by the studio's own Vite plugin straight from the tracked originals, so a
 * build that lacks them is one that does not serve that directory -- a static host that dropped
 * it, or a server other than the studio's.
 */
const MESHES_MISSING = 'this build does not serve tools/validate-external/myo_sim/meshes';

/** The Align lists that are saved, opened and kept as a draft, one each. */
type Section = 'pairs' | 'bones' | 'moves';

export function createAlignPanel(
  host: AlignHost,
  camera: Camera,
  renderer: WebGLRenderer,
): AlignPanel {
  const overlay = new SourceOverlay();
  const handles = new PointHandles();
  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.8);
  /**
   * Whether the Align tab is open, and with it every tool here. Everything starts off, the gizmo
   * included, and `attach` switches it all on when the studio opens on this tab.
   */
  let active = false;
  gizmo.enabled = false;
  /** Our segment picked in the bone pairing list, lit again when the tab comes back. */
  let highlighted: string | undefined;
  /** What the gizmo held when the tab was left, and how, handed back when it returns. */
  let parked: { target: GizmoTarget; mode: GizmoMode } | undefined;
  // A gizmo drag must not also orbit the camera, and three's own event says when it starts.
  gizmo.addEventListener('dragging-changed', (event) => {
    host.setGizmoDragging((event as unknown as { value: boolean }).value);
  });

  const ui = {
    model: must<HTMLSelectElement>('#align-model'),
    show: must<HTMLInputElement>('#align-show'),
    showBones: must<HTMLInputElement>('#align-show-bones'),
    modelNote: must<HTMLElement>('#align-model-note'),
    gizmoOff: must<HTMLButtonElement>('#align-gizmo-off'),
    gizmoMove: must<HTMLButtonElement>('#align-gizmo-move'),
    gizmoRotate: must<HTMLButtonElement>('#align-gizmo-rotate'),
    snap: must<HTMLInputElement>('#align-snap'),
    reset: must<HTMLButtonElement>('#align-reset'),
    theirs: must<HTMLSelectElement>('#align-theirs'),
    ours: must<HTMLSelectElement>('#align-ours'),
    theirsFind: must<HTMLInputElement>('#align-theirs-find'),
    oursFind: must<HTMLInputElement>('#align-ours-find'),
    theirsCount: must<HTMLOutputElement>('#align-theirs-count'),
    oursCount: must<HTMLOutputElement>('#align-ours-count'),
    pair: must<HTMLButtonElement>('#align-pair'),
    unpair: must<HTMLButtonElement>('#align-unpair'),
    pairNote: must<HTMLElement>('#align-pair-note'),
    pairs: must<HTMLSelectElement>('#align-pairs'),
    pairsCount: must<HTMLOutputElement>('#align-pairs-count'),
    savePairs: must<HTMLButtonElement>('#align-save-pairs'),
    openPairs: must<HTMLButtonElement>('#align-open-pairs'),
    points: must<HTMLSelectElement>('#align-points'),
    pointFind: must<HTMLInputElement>('#align-point-find'),
    pointCount: must<HTMLOutputElement>('#align-point-count'),
    pointList: must<HTMLSelectElement>('#align-point-list'),
    pointNote: must<HTMLElement>('#align-point-note'),
    reason: must<HTMLInputElement>('#align-reason'),
    keep: must<HTMLButtonElement>('#align-keep'),
    revert: must<HTMLButtonElement>('#align-revert'),
    theirBone: must<HTMLSelectElement>('#align-their-bone'),
    ourBone: must<HTMLSelectElement>('#align-our-bone'),
    theirBoneFind: must<HTMLInputElement>('#align-their-bone-find'),
    ourBoneFind: must<HTMLInputElement>('#align-our-bone-find'),
    pairBone: must<HTMLButtonElement>('#align-pair-bone'),
    unpairBone: must<HTMLButtonElement>('#align-unpair-bone'),
    bones: must<HTMLSelectElement>('#align-bones'),
    bonesCount: must<HTMLOutputElement>('#align-bones-count'),
    boneNote: must<HTMLElement>('#align-bone-note'),
    fitNote: must<HTMLElement>('#align-fit-note'),
    suggest: must<HTMLButtonElement>('#align-suggest'),
    retarget: must<HTMLButtonElement>('#align-retarget'),
    clearBones: must<HTMLButtonElement>('#align-clear-bones'),
    saveBones: must<HTMLButtonElement>('#align-save-bones'),
    openBones: must<HTMLButtonElement>('#align-open-bones'),
    moves: must<HTMLSelectElement>('#align-moves'),
    movesCount: must<HTMLOutputElement>('#align-moves-count'),
    saveMoves: must<HTMLButtonElement>('#align-save-moves'),
    openMoves: must<HTMLButtonElement>('#align-open-moves'),
  };
  const slider = (id: string) => must<HTMLInputElement>(`#align-${id}`);
  const PLACE: (keyof Placement)[] = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'scale'];

  /**
   * Where each reference model starts, as last worked out, by model: its seat on our body and the
   * sentence saying how it was reached, for the model note.
   */
  const seats = new Map<string, Seat>();
  /** Work out a model's seat on the body as it stands, and remember how, for the note. */
  const seatFor = (model: string): Seat => {
    const seat = seatReferenceModel(model, overlay.model(model), host.articulation());
    seats.set(model, seat);
    return seat;
  };
  /**
   * The models whose placement a person has changed, by slider or gizmo.
   *
   * Those are never seated again: a seat is a starting position, and replacing somebody's own
   * placement with it -- because the body was rebuilt, say -- would undo work they did by eye.
   * Reset placement takes a model off this list, which is how a person asks for the seat back.
   */
  const touched = new Set<string>();

  /**
   * Where each reference model has been put, by model.
   *
   * One placement for all of them meant a model picked after another arrived in the last one's
   * turn and place, and a Z-up model and a Y-up one need different turns just to stand up. So
   * each model keeps its own, starting from its seat on our body the first time it is asked for
   * (see `seatReferenceModel`), and going back to a model finds it where it was left.
   */
  const placements = new Map<string, Placement>();
  const placementOf = (model: string): Placement => {
    let p = placements.get(model);
    if (!p) {
      p = { ...seatFor(model).placement };
      placements.set(model, p);
    }
    return p;
  };
  /** The placement of the model picked now. */
  const placement = (): Placement => placementOf(ui.model.value);
  /**
   * The model on our bones and the placement it had before, defined exactly while the overlay is
   * redrawn on our bones.
   *
   * A redraw zeroes the placement, since the fits carry everything into our space themselves,
   * and the person's placement would be lost with it. So it is kept here, and every way out of a
   * redraw -- a slider, Reset, the gizmo, clearing the bone pairs, another model -- goes through
   * `showModel`, which puts it back. A second redraw keeps the first one's placement rather than
   * the neutral one it would otherwise read: the model's turn is what bones with nothing fitted
   * above them inherit.
   */
  let beforeRetarget: { model: string; placement: Placement } | undefined;
  const pairs: Pair[] = [];
  const moves: Move[] = [];
  /**
   * Moves of our points not kept yet, by point id: where each was dragged to.
   *
   * A redraw of the handles -- a rebuild, or a switch of kind and back -- used to put every point
   * back where the body puts it, so a drag nobody had kept yet was lost without a word. They are
   * drawn from here in their own colour until they are kept or put back.
   */
  const pending = new Map<string, Vector3>();
  /** Kept moves stale on the body shown: their `from` is not where this body puts the point. */
  let stale: string[] = [];
  /** Bone pairs per model, because each reference model has its own bones. */
  const bonePairs = new Map<string, StampedBonePair[]>();
  const bonesFor = (model: string): StampedBonePair[] => {
    const list = bonePairs.get(model) ?? [];
    bonePairs.set(model, list);
    return list;
  };
  /**
   * The bone pairs Clear bone pairs took away, while they can still be put back.
   *
   * Clearing is undone by a second click rather than asked about first, because a confirmation
   * dialog is not dependable in the desktop shell's webview. Anything that changes the pairs
   * since -- a pair, an unpair, a suggestion, another model -- makes the old list a different
   * decision, and the chance to restore it goes; a saved bone pairing can still be opened again.
   */
  let cleared: { model: string; list: StampedBonePair[] } | undefined;

  // ---- saved, opened, and kept as a draft ------------------------------------------------
  /** The reference sites taken so far, so taking the same ones twice does nothing. */
  let adopted: SourceSites | undefined;
  /** Which extraction of the reference models is on screen, for the files' provenance. */
  let sourceStamp: SourceSitesStamp | undefined;
  /**
   * What the model note says when no model is picked: that the reference data is loading, has
   * loaded, could not be loaded, or that a draft was restored.
   */
  let idleNote = {
    text: 'No reference model shown. Pick one to place it or pair with it.',
    error: false,
  };
  /**
   * Edits and saves, counted per list. A list is unsaved while it has been edited since the save
   * last written; counting rather than flagging means a change made while a save dialog is open
   * is not marked saved when that save lands.
   */
  const edits: Record<Section, number> = { pairs: 0, bones: 0, moves: 0 };
  const saved: Record<Section, number> = { pairs: 0, bones: 0, moves: 0 };
  const unsaved = (): boolean =>
    (Object.keys(edits) as Section[]).some((section) => edits[section] !== saved[section]);
  /**
   * The page's memory, for the draft. An authoring draft is the one thing it keeps that is not
   * layout: see `ui/memory.ts` for why it belongs there.
   */
  const memory = createMemory();
  /**
   * Whether a draft left by the last visit has had its chance to be restored.
   *
   * The draft is not written before then: a move kept before the reference data arrives would
   * otherwise overwrite the draft it was about to be offered.
   */
  let draftChecked = false;
  const documents = (): { pairs: string; bones: string; moves: string } => {
    const body = host.body();
    const decidedAt = new Date().toISOString();
    return {
      pairs: serialise(
        correspondenceDocument({
          pairs,
          sourceSites: sourceStamp,
          profile: body?.profile,
          decidedAt,
        }),
      ),
      bones: serialise(
        bonePairingDocument({ models: bonePairs, body, sourceSites: sourceStamp, decidedAt }),
      ),
      moves: serialise(overridesDocument({ moves, body, decidedAt })),
    };
  };
  /** Count an edit to one list and keep the draft up with it. */
  const changed = (section: Section): void => {
    edits[section] += 1;
    if (!draftChecked) return;
    const texts = documents();
    writeDraft(memory, {
      correspondence: texts.pairs,
      bones: texts.bones,
      overrides: texts.moves,
    });
  };
  const FILE_NAMES: Record<Section, string> = {
    pairs: 'sourceCorrespondence.json',
    bones: 'bonePairing.json',
    moves: 'pointOverrides.json',
  };
  /** Save one list through the host, and count it saved only once the host says it was written. */
  const save = (section: Section): void => {
    const at = edits[section];
    void host.save(FILE_NAMES[section], documents()[section]).then((written) => {
      if (written) saved[section] = at;
    });
  };
  /**
   * Warn before a reload or a closed tab takes unsaved work.
   *
   * The draft would bring it back on the next visit, but only in this browser; a person who meant
   * to save it should hear that they have not.
   */
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (unsaved()) event.preventDefault();
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  // ---- lists that keep what the person picked --------------------------------------------
  /**
   * Rebuild a list's rows, keeping its selection and where it was scrolled to.
   *
   * Every list here is rebuilt after every pair and every keystroke in a filter, and rebuilding
   * with nothing kept threw away the row somebody had scrolled to and picked -- so the Pair button
   * went dead under a selection that was still on screen a moment before.
   */
  const refill = (select: HTMLSelectElement, rows: readonly { value: string; label: string }[]) => {
    const value = select.value;
    const scroll = select.scrollTop;
    select.replaceChildren(
      ...rows.map((row) => {
        const option = document.createElement('option');
        option.value = row.value;
        option.textContent = row.label;
        return option;
      }),
    );
    if (value && rows.some((row) => row.value === value)) select.value = value;
    select.scrollTop = scroll;
    syncSelection();
  };
  const refreshPairButton = (): void => {
    ui.pair.disabled = !(ui.theirs.value && ui.ours.value);
  };
  const refreshBoneButton = (): void => {
    ui.pairBone.disabled = !(ui.theirBone.value && ui.ourBone.value);
  };
  /**
   * Make the buttons and the viewport agree with what the lists have selected.
   *
   * A button is enabled exactly when there is something selected for it to act on, and the muscle
   * lit, their bone lit and our segment tinted are the ones selected -- whether the selection came
   * from a click or survived a rebuild.
   */
  const syncSelection = (): void => {
    refreshPairButton();
    refreshBoneButton();
    ui.unpair.disabled = !ui.pairs.value;
    ui.unpairBone.disabled = !ui.bones.value;
    overlay.emphasise(ui.theirs.value || undefined);
    overlay.emphasiseBone(ui.theirBone.value || undefined);
    highlighted = ui.ourBone.value || undefined;
    // Only while the tab is open: the tint is drawn on the body every tab shares.
    if (active) host.highlightSegment(highlighted);
  };
  /**
   * Enable what can act now, and say what is missing for what cannot.
   *
   * Suggest by name and Redraw need our segments, which exist only once a run has started, and a
   * reference model to match them to; with either missing they were enabled and did nothing when
   * pressed. Now they are disabled, and the notes of the two sections that need a body say how to
   * get one. The notes are cleared again only while they still say that, so a body arriving does
   * not wipe what the last action said.
   */
  const syncReadiness = (): void => {
    const body = host.articulation() !== undefined;
    const model = ui.model.value !== '';
    ui.suggest.disabled = !(body && model);
    ui.retarget.disabled = !(body && model && bonesFor(ui.model.value).length > 0);
    for (const note of [ui.boneNote, ui.pairNote]) {
      if (!body) note.textContent = START_NOTE;
      else if (note.textContent === START_NOTE) note.textContent = '';
    }
  };
  /** Our unit ids, when there is a body to have any; a pair naming one it lacks is marked. */
  const ourUnits = (): ReadonlySet<string> | undefined => {
    const units = host.units();
    return host.articulation() && units.length > 0 ? new Set(units) : undefined;
  };

  // ---- the gizmo ------------------------------------------------------------------------
  /** Which of those the gizmo holds now. */
  const gizmoTarget = (): GizmoTarget =>
    gizmo.object === overlay.group ? 'model' : gizmo.object === proxy ? 'point' : 'off';
  /** Whether there is a model on screen for the gizmo to hold. */
  const modelMovable = (): boolean =>
    ui.model.value !== '' && (ui.show.checked || ui.showBones.checked);
  /**
   * Put the gizmo on something, or take it off, and have the buttons say so.
   *
   * The only place the gizmo is attached, detached or switched between moving and turning. When
   * each caller did its own, the button's label was written by one of them and not the others,
   * and it named the mode the gizmo would switch to next rather than the one it was in.
   */
  const setGizmo = (target: GizmoTarget, mode?: GizmoMode): void => {
    if (target === 'off') gizmo.detach();
    else gizmo.attach(target === 'model' ? overlay.group : proxy);
    if (mode) gizmo.setMode(mode);
    showGizmo();
  };
  /**
   * The buttons, from the gizmo as it is.
   *
   * On a picked point the gizmo only moves -- a point has no turn of its own -- and the pressed
   * button says Point, because Move would claim the whole model is under it.
   */
  const showGizmo = (): void => {
    const target = gizmoTarget();
    const pressed = (button: HTMLButtonElement, on: boolean): void => {
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    };
    pressed(ui.gizmoOff, target === 'off');
    pressed(ui.gizmoMove, target === 'point' || (target === 'model' && gizmo.mode === 'translate'));
    pressed(ui.gizmoRotate, target === 'model' && gizmo.mode === 'rotate');
    ui.gizmoMove.textContent = target === 'point' ? 'Point' : 'Move';
    ui.gizmoMove.title =
      target === 'point'
        ? 'Moving the picked point of ours; press to move the whole model instead (W)'
        : "Move the whole model with the gizmo's arrows (W)";
    const movable = modelMovable();
    ui.gizmoMove.disabled = !movable;
    ui.gizmoRotate.disabled = !movable;
  };
  /**
   * Put the gizmo on the whole model, first dropping a redraw if there is one.
   *
   * Moving the model while it is on our bones would take it back off them, so the gizmo drops the
   * redraw the way a slider does and starts from the placement the person gave it. With nothing
   * of the model on screen -- E pressed with both boxes unticked -- it says so rather than doing
   * nothing.
   */
  const grabModel = (mode: GizmoMode): void => {
    if (!modelMovable()) {
      ui.modelNote.textContent = ui.model.value
        ? 'Nothing of the model is on screen for the gizmo to hold: tick Show their muscles or ' +
          'Show their bones.'
        : 'Pick a reference model first; the gizmo moves the whole model.';
      return;
    }
    if (beforeRetarget) showModel();
    setGizmo('model', mode);
  };
  ui.gizmoOff.addEventListener('click', () => setGizmo('off'));
  ui.gizmoMove.addEventListener('click', () => grabModel('translate'));
  ui.gizmoRotate.addEventListener('click', () => grabModel('rotate'));
  // Steps for the hand, not physical quantities: the translation step is the position sliders'
  // own, so a snapped drag lands on values a slider can show.
  ui.snap.addEventListener('change', () => {
    gizmo.setTranslationSnap(ui.snap.checked ? 0.005 : null);
    gizmo.setRotationSnap(ui.snap.checked ? MathUtils.degToRad(5) : null);
  });
  /**
   * W moves, E turns and Esc lets go, as in most 3D editors, while the tab is open and the gizmo
   * holds something.
   *
   * A control keeps the keys it acts on, so typing a W into a filter or a reason types it; a
   * focused button does not own W or E, which matters because focus is left on Move straight
   * after it is clicked. None of the three is one of the studio's own shortcuts.
   */
  const onKey = (event: KeyboardEvent): void => {
    if (!active || gizmoTarget() === 'off') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (keyOwnedByTarget(event.target, event.key)) return;
    switch (event.key) {
      case 'w':
      case 'W':
        // On a point the gizmo is already moving the point; W keeps it there.
        if (gizmoTarget() === 'model') setGizmo('model', 'translate');
        break;
      case 'e':
      case 'E':
        grabModel('rotate');
        break;
      case 'Escape':
        setGizmo('off');
        break;
      default:
        return;
    }
  };
  window.addEventListener('keydown', onKey);

  // ---- the reference model --------------------------------------------------------------
  const writeSliders = (p: Placement): void => {
    for (const key of PLACE) {
      const input = slider(key);
      input.value = String(p[key]);
      must<HTMLOutputElement>(`#align-${key}-value`).textContent =
        key === 'scale' || key === 'x' || key === 'y' || key === 'z'
          ? p[key].toFixed(2)
          : String(Math.round(p[key]));
    }
  };
  const applyPlacement = (p: Placement): void => {
    placements.set(ui.model.value, p);
    overlay.place(p);
    writeSliders(p);
  };
  for (const key of PLACE) {
    slider(key).addEventListener('input', () => {
      // Read before a redraw is dropped, which writes the kept placement back onto every slider.
      const value = Number(slider(key).value);
      // Moving the whole model once it is on our bones would take it back off them, so the
      // first nudge of a slider drops the redraw and puts their own geometry back, where it was
      // placed before; the slider being dragged carries on from there.
      if (beforeRetarget) showModel();
      // Only the slider that moved is read. A slider can only hold values inside its range and
      // on its step, and the gizmo is under neither limit, so reading them all back snapped a
      // model dragged past a slider's end back inside it the moment another slider was touched.
      touched.add(ui.model.value);
      applyPlacement({ ...placement(), [key]: value });
    });
  }
  // Back to the seat, worked out again on the body as it stands: the model's own change of axes,
  // sized to us and sat on our body, which is where it started. Not the bare change of axes, which
  // put every model at our origin and the legs' pelvis at our feet.
  ui.reset.addEventListener('click', () => {
    if (beforeRetarget) showModel();
    const model = ui.model.value;
    touched.delete(model);
    applyPlacement({ ...seatFor(model).placement });
    writeModelNote();
  });
  /**
   * Seat again, on a rebuilt body, every model nobody has placed by hand.
   *
   * A seat is a function of our body, and a rebuild at another profile or stature moves the joints
   * it sits on. A model a person has moved keeps their placement, whatever the body did.
   */
  const reseat = (): void => {
    for (const model of placements.keys()) {
      if (!model || touched.has(model)) continue;
      const seat = { ...seatFor(model).placement };
      if (beforeRetarget?.model === model) {
        // On screen as a redraw at neutral; the seat is what dropping the redraw goes back to.
        beforeRetarget = { model, placement: seat };
        continue;
      }
      placements.set(model, seat);
      if (model === ui.model.value) {
        overlay.place(seat);
        writeSliders(seat);
      }
    }
  };

  /** Loads of their bones, counted, so a slow load does not report over a newer one. */
  let meshLoad = 0;
  /** How many of the picked model's bone meshes loaded, once its load has settled. */
  let meshes: { model: string; count: MeshCount } | undefined;
  /** What the note says about their bones: all there, some missing, none, or still loading. */
  const bonesClause = (model: string): string => {
    if (meshes?.model !== model) return '; loading its bones…';
    const { total, loaded } = meshes.count;
    if (loaded >= total) return ', and its bones.';
    if (loaded === 0) return `; none of its ${total} bone meshes are served: ${MESHES_MISSING}.`;
    return `; its bones: ${loaded} of ${total} meshes loaded: ${MESHES_MISSING}.`;
  };
  /**
   * What the model note says: what is shown, how many of its bones arrived, whether the gizmo can
   * take it, and how it was seated.
   */
  const writeModelNote = (): void => {
    const model = ui.model.value;
    if (!model) {
      ui.modelNote.textContent = idleNote.text;
      ui.modelNote.classList.toggle('error', idleNote.error);
      return;
    }
    ui.modelNote.classList.remove('error');
    const n = overlay.muscles(model).length;
    const hint = modelMovable()
      ? 'Untick either to hide it.'
      : 'Tick either to see it, and to move it with the gizmo.';
    const seat = touched.has(model) ? '' : ` ${seats.get(model)?.how ?? ''}`;
    ui.modelNote.textContent =
      `${n} muscles on the reference ${model}${bonesClause(model)} ${hint}${seat}`.trimEnd();
  };
  /** Let go of the model when there is nothing of it on screen to hold. */
  const settleGizmo = (): void => {
    if (gizmoTarget() === 'model' && !modelMovable()) setGizmo('off');
    else showGizmo();
    writeModelNote();
  };

  /**
   * Draw the picked model in its own world, at its own placement.
   *
   * The one way out of a redraw: whatever drops it comes through here, which puts back the
   * placement the redraw zeroed and says the redraw has gone, so the fit note never describes a
   * drawing that is no longer on screen.
   */
  const showModel = (): void => {
    const model = ui.model.value;
    if (beforeRetarget) {
      const dropped = beforeRetarget;
      beforeRetarget = undefined;
      placements.set(dropped.model, dropped.placement);
      ui.fitNote.textContent =
        dropped.model === model
          ? 'Redraw dropped: their model is back in its own world, where you placed it. ' +
            'Redraw again after moving it.'
          : '';
    } else {
      ui.fitNote.textContent = '';
    }
    // A model picked with both layers off would be picked and invisible, which reads as a model
    // that failed to load. A redraw nobody can see is the same as no redraw, and so is a model.
    if (model && !ui.show.checked && !ui.showBones.checked) {
      ui.show.checked = true;
      ui.showBones.checked = true;
    }
    overlay.clear();
    if (model) overlay.show(model);
    overlay.visible = active && ui.show.checked && model !== '';
    if (model) {
      // The count is only written for the load that is still the latest, and only while the
      // model it was for is still the one picked.
      if (meshes?.model !== model) meshes = undefined;
      const load = ++meshLoad;
      void overlay.showBones(model).then((count) => {
        if (load !== meshLoad || ui.model.value !== model) return;
        meshes = { model, count };
        writeModelNote();
      });
    }
    overlay.bonesVisible = active && ui.showBones.checked && model !== '';
    overlay.place(placement());
    writeSliders(placement());
    // Lets go of the model when there is none, and leaves a gizmo on a point of ours alone.
    settleGizmo();
    fillTheirs();
    fillBones();
  };
  // A model picked for the first time starts from its seat on our body, and one picked before
  // from wherever it was left (see `placements`).
  ui.model.addEventListener('change', () => {
    // Cleared here and not in `showModel`, because clearing the bone pairs goes through
    // `showModel` too, and its note has to survive that.
    boneAction = '';
    cleared = undefined;
    showModel();
  });
  ui.show.addEventListener('change', () => {
    overlay.visible = ui.show.checked && ui.model.value !== '';
    settleGizmo();
  });
  ui.showBones.addEventListener('change', () => {
    overlay.bonesVisible = ui.showBones.checked && ui.model.value !== '';
    settleGizmo();
  });
  // When the gizmo has moved the overlay, the sliders have to agree with it.
  gizmo.addEventListener('objectChange', () => {
    if (gizmo.object === overlay.group) {
      // Never while the model is on our bones: the gizmo lets go of the model when it is redrawn
      // and drops the redraw before taking it again, so this is a guard against a path that has
      // been missed, not one that is expected.
      if (beforeRetarget) return;
      // `place` moves the bones with the muscles, so reading one and applying both keeps the
      // skeleton and its muscles together under the gizmo.
      touched.add(ui.model.value);
      applyPlacement(overlay.readPlacement());
    } else if (gizmo.object && handles.pickedHandle) {
      const h = handles.pickedHandle;
      handles.moveTo(gizmo.object.position.clone());
      // Where it was dragged, until it is kept or put back; nothing, once it is back where the
      // body put it.
      if (h.world.distanceTo(h.original) <= KEPT_MATCH) pending.delete(h.id);
      else pending.set(h.id, h.world.clone());
      showPicked();
    }
  });

  // ---- correspondence -------------------------------------------------------------------
  const fillTheirs = (): void => {
    const model = ui.model.value;
    const filter = ui.theirsFind.value.trim().toLowerCase();
    const done = pairedIn(pairs, model);
    const list = overlay
      .muscles(model)
      .filter((m) => !filter || m.name.toLowerCase().includes(filter));
    ui.theirsCount.textContent = `${list.length}`;
    overlay.markPaired(done);
    refill(
      ui.theirs,
      list.map((m) => ({
        value: m.name,
        label: `${done.has(m.name) ? '· ' : ''}${m.name}  (${m.bodies.join(' → ')})`,
      })),
    );
  };
  const fillOurs = (): void => {
    const filter = ui.oursFind.value.trim().toLowerCase();
    const list = host.units().filter((u) => !filter || u.toLowerCase().includes(filter));
    ui.oursCount.textContent = `${list.length}`;
    refill(
      ui.ours,
      list.map((u) => ({ value: u, label: u })),
    );
  };
  ui.theirsFind.addEventListener('input', fillTheirs);
  ui.oursFind.addEventListener('input', fillOurs);
  ui.theirs.addEventListener('change', syncSelection);
  ui.ours.addEventListener('change', syncSelection);
  ui.pairs.addEventListener('change', syncSelection);

  const fillPairs = (): void => {
    ui.pairsCount.textContent = `${pairs.length}`;
    // A pair opened from a file may name a unit this body does not have -- units differ by
    // profile -- and is kept, marked, rather than dropped.
    const units = ourUnits();
    // A row is found again by its place in the list: one of theirs may be paired with several of
    // ours, so their muscle alone does not say which row was picked.
    refill(
      ui.pairs,
      pairs.map((p, i) => ({
        value: String(i),
        label: `${units && !units.has(p.ours) ? '? ' : ''}${pairLabel(p)}`,
      })),
    );
    fillTheirs();
  };
  ui.pair.addEventListener('click', () => {
    const theirs = ui.theirs.value;
    const ours = ui.ours.value;
    const model = ui.model.value;
    if (!theirs || !ours || !model) return;
    if (pairs.some((p) => p.model === model && p.theirs === theirs && p.ours === ours)) {
      ui.pairNote.textContent = `${theirs} is already paired with ${ours}.`;
      return;
    }
    pairs.push({ theirs, ours, model });
    // Many of theirs may map to one of ours, so `ours` is deliberately not made unique.
    const together = pairs.filter((p) => p.ours === ours).length;
    ui.pairNote.textContent =
      together > 1
        ? `${theirs} → ${ours}. That is ${together} of theirs on this one of ours.`
        : `${theirs} → ${ours}.`;
    fillPairs();
    changed('pairs');
  });
  ui.unpair.addEventListener('click', () => {
    if (!ui.pairs.value) return;
    const gone = unpairAt(pairs, Number(ui.pairs.value));
    if (!gone) return;
    // The rows after it move up an index, so the kept selection would land on the next pair and a
    // second click would take that one too.
    ui.pairs.selectedIndex = -1;
    ui.pairNote.textContent = `${gone.theirs} (${gone.model}) is no longer paired with ${gone.ours}.`;
    fillPairs();
    changed('pairs');
  });
  ui.savePairs.addEventListener('click', () => save('pairs'));

  // ---- our points -----------------------------------------------------------------------
  /** The kept moves by point id, as the handles read them. */
  const keptMap = (): ReadonlyMap<string, Move> => new Map(moves.map((m) => [m.id, m]));
  /** What Our points says when no point is picked: what is shown and how many of each. */
  let pointSummary = 'No point picked.';
  /** Millimetres for the eye, from the metres a move is kept in. */
  const mm = (metres: number): string => (1000 * metres).toFixed(1);
  const showPicked = (): void => {
    const h = handles.pickedHandle;
    if (!h) {
      ui.pointNote.textContent = pointSummary;
      ui.keep.disabled = true;
      ui.keep.title = '';
      ui.revert.disabled = true;
      return;
    }
    const moved = 1000 * h.world.distanceTo(h.original);
    let note =
      `${h.id} on ${h.on} — ${mm(h.world.x)}, ${mm(h.world.y)}, ${mm(h.world.z)} mm` +
      (moved > 0.01 ? `  ·  moved ${moved.toFixed(1)} mm` : '');
    if (h.kind === 'vias') {
      // Read-only in this pass: an override names a site on a bone, and a via point's site is
      // shared by the path solver in a way an override does not describe yet.
      note += '  ·  via points can be inspected but not moved yet';
      ui.keep.disabled = true;
      ui.keep.title = 'Via points are read-only for now';
      ui.revert.disabled = true;
    } else {
      // Keep asks for a reason, and a disabled button with no word of why looked broken.
      const needsReason = moved > 0.01 && ui.reason.value.trim() === '';
      const hint = 'write why it moved to keep it';
      if (needsReason) note += `  ·  ${hint}`;
      ui.keep.disabled = moved <= 0.01 || needsReason;
      ui.keep.title = needsReason ? hint : '';
      ui.revert.disabled = moved <= 0.01;
    }
    ui.pointNote.textContent = note;
  };
  ui.reason.addEventListener('input', showPicked);

  /** Hold the body at rest exactly while points are shown on a body, in this tab. */
  const syncHold = (): void => {
    host.holdRest(Boolean(ui.points.value && host.articulation() && active));
  };
  const NOUNS: Record<HandleKind, string> = {
    joints: 'joint centres',
    sites: 'origins and insertions',
    vias: 'via points',
  };
  /** The handles of one kind on a body, at rest. */
  const handlesOf = (kind: HandleKind, articulation: CompiledArticulation): Handle[] =>
    kind === 'joints'
      ? PointHandles.jointsOf(articulation)
      : kind === 'sites'
        ? PointHandles.sitesOf(articulation, host.sites())
        : PointHandles.viasOf(viaPoints(articulation, host.muscles()));
  /**
   * Kept moves made on a body other than the one shown, said in a sentence.
   *
   * They are not dropped: a move made on L3 is still a claim about L3, and it is saved with that
   * body named. It is only not drawn where this body puts the point (see `stale`).
   */
  const otherBodies = (): string => {
    const body = host.body();
    if (!body) return '';
    const elsewhere = moves.filter(
      (m) =>
        m.profile !== undefined &&
        (m.profile !== body.profile ||
          JSON.stringify(m.morphology) !== JSON.stringify(body.morphology)),
    );
    if (elsewhere.length === 0) return '';
    const names = [...new Set(elsewhere.map((m) => m.profile))].join(', ');
    return (
      ` ${elsewhere.length} kept ${elsewhere.length === 1 ? 'move was' : 'moves were'} made on ` +
      `${names} or at another size; they are saved with that body named.`
    );
  };
  /** The list of points under What to show, filtered by name or by what each is on. */
  const fillPointList = (): void => {
    const filter = ui.pointFind.value.trim().toLowerCase();
    const kept = keptMap();
    const rows = handles.all.filter(
      (h) => !filter || h.id.toLowerCase().includes(filter) || h.on.toLowerCase().includes(filter),
    );
    ui.pointCount.textContent = handles.all.length > 0 ? `${rows.length}` : '';
    refill(
      ui.pointList,
      rows.map((h) => ({ value: h.id, label: `${kept.has(h.id) ? '· ' : ''}${h.id}  (${h.on})` })),
    );
  };
  ui.pointFind.addEventListener('input', fillPointList);
  const showPoints = (): void => {
    const kind = ui.points.value as HandleKind | '';
    const articulation = host.articulation();
    syncHold();
    if (!kind || !articulation) {
      handles.clear();
      handles.visible = false;
      stale = [];
      // Only a gizmo on a point lets go: the model's gizmo has nothing to do with the points.
      if (gizmoTarget() === 'point') setGizmo('off');
      pointSummary = (kind ? POINTS_NEED_BODY : 'No point picked.') + otherBodies();
      fillPointList();
      showPicked();
      return;
    }
    ({ stale } = handles.show(handlesOf(kind, articulation), keptMap(), pending));
    // Redrawing the handles forgets the pick, so a gizmo left on it would move nothing.
    if (gizmoTarget() === 'point') setGizmo('off');
    // Not simply on: a rebuild in another tab runs this too (`refresh`), and must not bring the
    // handles back into a viewport that is not aligning anything.
    handles.visible = active;
    const shown = new Set(handles.all.map((h) => h.id));
    const kept = moves.filter((m) => m.kind === kind && shown.has(m.id)).length - stale.length;
    const moving = [...pending.keys()].filter((id) => shown.has(id)).length;
    pointSummary =
      `${handles.all.length} ${NOUNS[kind]}, ${kept} kept, ${moving} moved but not kept, ` +
      `${stale.length} kept on another body. ` +
      (kind === 'vias'
        ? 'Via points are read-only for now: click one, or find it by name, to inspect it.'
        : 'Click one, or find it by name.') +
      otherBodies();
    fillPointList();
    showPicked();
  };
  ui.points.addEventListener('change', showPoints);

  // Picking: the handle drawn nearest the pointer, measured on the screen.
  //
  // The gizmo drives an empty that the picked handle follows, because the handles are one Points
  // cloud and a cloud has no node per point for a gizmo to attach to.
  const proxy = new Object3D();
  proxy.name = 'align-gizmo-proxy';
  /**
   * Pick a handle by its place in the drawn list, from the viewport or from a list, and put the
   * gizmo on it -- except on a via point, which is read-only and only inspected.
   */
  const selectHandle = (index: number): boolean => {
    const h = handles.pick(index);
    if (!h) return false;
    // Only when the list shows it: a filter may have hidden the point picked in the viewport.
    if ([...ui.pointList.options].some((option) => option.value === h.id)) {
      ui.pointList.value = h.id;
    }
    if (h.kind === 'vias') {
      if (gizmoTarget() === 'point') setGizmo('off');
    } else {
      proxy.position.copy(h.world);
      setGizmo('point', 'translate');
    }
    showPicked();
    return true;
  };
  const pickPoint = (clientX: number, clientY: number): boolean => {
    // Over a gizmo handle the press belongs to the gizmo, not to picking a new point.
    if (!active || !handles.visible || gizmo.axis !== null || gizmo.dragging) return false;
    const rect = renderer.domElement.getBoundingClientRect();
    const at = handles.nearestOnScreen(camera, rect, clientX, clientY);
    if (at < 0) return false;
    return selectHandle(at);
  };
  ui.pointList.addEventListener('change', () => {
    selectHandle(handles.indexOf(ui.pointList.value));
  });

  // A pick is a click, not a press. Picking on the press, as this did, took the first instant of
  // every orbit and pan that happened to start on a dot, and did it while the camera was being
  // handed the same press. So the press is only watched here -- how far it travels, and whether it
  // began on the gizmo -- and the pick waits for the click it ends in.
  const canvas = renderer.domElement;
  let lastX = 0;
  let lastY = 0;
  let travel = 0;
  let pressOnGizmo = false;
  canvas.addEventListener('pointerdown', (event) => {
    lastX = event.clientX;
    lastY = event.clientY;
    travel = 0;
    // Hover has already set `axis` by now, and three's own pointerdown, which runs before this
    // one, sets it for a touch that had no hover. After the release it is null again, so this is
    // the only moment the question can be asked.
    pressOnGizmo = gizmo.axis !== null || gizmo.dragging;
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.buttons === 0) return;
    travel += Math.abs(event.clientX - lastX) + Math.abs(event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  });
  /**
   * Pick on a click that stayed still, and keep the click from the studio's bone picking.
   *
   * The whole path the pointer took is counted, not only where it let go, so an orbit that
   * swung out and came back to the same pixel is still an orbit; the line is the orbit's own,
   * so the two never disagree about which presses were clicks. It listens on the window in the
   * capture phase, filtered to the canvas, because that runs before any listener on the canvas
   * itself in every browser -- the bone pick's included, which was registered first -- and
   * stopping the click there means the inspector's bone is not picked by the same click too.
   */
  const onClick = (event: MouseEvent): void => {
    if (event.target !== canvas || pressOnGizmo) return;
    const moved = travel + Math.abs(event.clientX - lastX) + Math.abs(event.clientY - lastY);
    if (moved > DRAG_THRESHOLD) return;
    if (!pickPoint(event.clientX, event.clientY)) return;
    event.stopPropagation();
  };
  window.addEventListener('click', onClick, { capture: true });

  ui.keep.addEventListener('click', () => {
    const move = handles.keep(ui.reason.value.trim());
    if (!move) return;
    // Stamped with the body it was made on, so a file of moves says what they were judged against
    // and a rebuild at another body can say which moves belong elsewhere.
    const stamped: Move = { ...move, ...host.body() };
    pending.delete(move.id);
    const at = moves.findIndex((m) => m.id === move.id);
    if (at >= 0) moves.splice(at, 1, stamped);
    else moves.push(stamped);
    ui.reason.value = '';
    handles.recolour(keptMap());
    fillMoves();
    fillPointList();
    showPicked();
    changed('moves');
  });
  ui.revert.addEventListener('click', () => {
    const h = handles.revert();
    if (!h) return;
    pending.delete(h.id);
    const at = moves.findIndex((m) => m.id === h.id);
    if (at >= 0) moves.splice(at, 1);
    handles.recolour(keptMap());
    // The gizmo stays on the point, which is back where it started, so the gizmo goes with it.
    proxy.position.copy(h.world);
    fillMoves();
    fillPointList();
    showPicked();
    if (at >= 0) changed('moves');
  });
  const fillMoves = (): void => {
    const value = ui.moves.value;
    ui.moves.replaceChildren(
      ...moves.map((m) => {
        const option = document.createElement('option');
        option.value = m.id;
        option.textContent = `${m.id}  ${m.moved.toFixed(1)} mm`;
        return option;
      }),
    );
    if (value && moves.some((m) => m.id === value)) ui.moves.value = value;
    ui.movesCount.textContent = `${moves.length}`;
  };
  // A row of Moved so far goes to its point: switching to its kind when another is shown, so a
  // kept move is one click from the gizmo on it.
  ui.moves.addEventListener('change', () => {
    const m = moves.find((move) => move.id === ui.moves.value);
    if (!m) return;
    if (m.kind !== ui.points.value) {
      ui.points.value = m.kind;
      showPoints();
    }
    selectHandle(handles.indexOf(m.id));
  });
  ui.saveMoves.addEventListener('click', () => save('moves'));

  // ---- bone pairing, which is what actually registers the two bodies -------------------
  /**
   * What the last bone pairing action said, kept apart from what the list says about itself, so
   * a rebuild of the list can restate the one without losing the other.
   */
  let boneAction = '';
  /** Our segment ids in the body built now, or nothing before one is built. */
  const segmentIds = (): ReadonlySet<string> | undefined => {
    const articulation = host.articulation();
    return articulation ? new Set(articulation.segments.map((s) => s.id)) : undefined;
  };
  /**
   * The bone pairs of a model whose segment the body built now does not have, by their bone.
   *
   * Empty before a body is built: with no body there is nothing to be missing from, and marking
   * every pair would say they were all wrong.
   */
  const unbuilt = (list: readonly StampedBonePair[]): Set<string> => {
    const ids = segmentIds();
    return new Set(ids ? missingSegments(list, ids).map((p) => p.theirs) : []);
  };
  const fillTheirBones = (): void => {
    const model = overlay.model(ui.model.value);
    const done = new Set(bonesFor(ui.model.value).map((p) => p.theirs));
    const filter = ui.theirBoneFind.value.trim().toLowerCase();
    refill(
      ui.theirBone,
      (model?.bodies ?? [])
        .filter((body) => !filter || body.name.toLowerCase().includes(filter))
        .map((body) => ({
          value: body.name,
          label: `${done.has(body.name) ? '· ' : ''}${body.name}`,
        })),
    );
  };
  /**
   * Our segments, from the body as built.
   *
   * Rebuilt when the body is (`refresh`) and when the filter changes, not after every pair: it
   * does not depend on the pairs, and rebuilding it with them was what made it lose its place.
   * Before a body is built there are no segments, and the list is left empty.
   */
  const fillOurBones = (): void => {
    const filter = ui.ourBoneFind.value.trim().toLowerCase();
    refill(
      ui.ourBone,
      (host.articulation()?.segments ?? [])
        .filter((seg) => !filter || seg.id.toLowerCase().includes(filter))
        .map((seg) => ({ value: seg.id, label: seg.id })),
    );
  };
  const fillBones = (): void => {
    const list = bonesFor(ui.model.value);
    const missing = unbuilt(list);
    ui.bonesCount.textContent = `${list.length}`;
    ui.clearBones.textContent = cleared
      ? `Restore ${cleared.list.length} bone pairs`
      : 'Clear bone pairs';
    ui.clearBones.disabled = !cleared && list.length === 0;
    ui.boneNote.textContent = [
      boneAction,
      missing.size > 0
        ? `${missing.size} of these pairs name a segment not in this body, and fit nothing ` +
          'until a body with it is built.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    refill(
      ui.bones,
      list.map((p) => ({
        value: p.theirs,
        label:
          `${missing.has(p.theirs) ? '? ' : ''}${p.theirs}  →  ${p.ours}` +
          `${missing.has(p.theirs) ? ' (not in this body)' : ''}` +
          `${p.decidedBy === 'name' ? '  · by name' : ''}`,
      })),
    );
    fillTheirBones();
    // Redraw's enabled state and the start-a-run note follow the list, so they are settled here.
    syncReadiness();
  };
  /** Say what a bone pairing action did, and forget any clear that could still be restored. */
  const boneChanged = (note: string): void => {
    boneAction = note;
    cleared = undefined;
    fillBones();
    changed('bones');
  };
  ui.theirBoneFind.addEventListener('input', fillTheirBones);
  ui.ourBoneFind.addEventListener('input', fillOurBones);
  ui.theirBone.addEventListener('change', syncSelection);
  ui.ourBone.addEventListener('change', syncSelection);
  ui.bones.addEventListener('change', syncSelection);
  ui.pairBone.addEventListener('click', () => {
    const theirs = ui.theirBone.value;
    const ours = ui.ourBone.value;
    if (!theirs || !ours) return;
    const list = bonesFor(ui.model.value);
    const at = list.findIndex((p) => p.theirs === theirs);
    const profile = host.body()?.profile;
    const pair: StampedBonePair = {
      theirs,
      ours,
      decidedBy: 'eye',
      ...(profile ? { profile } : {}),
    };
    // One of their bones sits on exactly one of ours, so a second pairing replaces the first.
    if (at >= 0) list.splice(at, 1, pair);
    else list.push(pair);
    boneChanged(`${theirs} → ${ours}.`);
  });
  ui.unpairBone.addEventListener('click', () => {
    const list = bonesFor(ui.model.value);
    const at = list.findIndex((p) => p.theirs === ui.bones.value);
    if (at < 0) return;
    const [gone] = list.splice(at, 1);
    ui.bones.selectedIndex = -1;
    boneChanged(gone ? `${gone.theirs} is no longer paired with ${gone.ours}.` : '');
  });
  ui.clearBones.addEventListener('click', () => {
    const model = ui.model.value;
    if (cleared) {
      bonePairs.set(cleared.model, cleared.list);
      boneAction = `${cleared.list.length} bone pairs restored.`;
      cleared = undefined;
      fillBones();
      changed('bones');
      return;
    }
    const list = bonesFor(model);
    if (list.length === 0) return;
    cleared = { model, list };
    bonePairs.set(model, []);
    boneAction = `${list.length} bone pairs cleared. Click Restore to put them back.`;
    changed('bones');
    // A redraw made from the pairs is dropped with them; `showModel` redraws the list as well.
    showModel();
  });
  ui.suggest.addEventListener('click', () => {
    const model = overlay.model(ui.model.value);
    const articulation = host.articulation();
    // A second guard behind the disabled button, which says what is missing rather than nothing.
    if (!articulation) {
      ui.boneNote.textContent = START_NOTE;
      return;
    }
    if (!model) {
      ui.boneNote.textContent = 'Pick a reference model first: Suggest matches its bones by name.';
      return;
    }
    const suggested = suggestBodyPairs(
      model,
      articulation.segments.map((s) => s.id),
    );
    const list = bonesFor(ui.model.value);
    const profile = host.body()?.profile;
    let added = 0;
    for (const p of suggested) {
      if (!list.some((existing) => existing.theirs === p.theirs)) {
        list.push({ ...p, decidedBy: 'name', ...(profile ? { profile } : {}) });
        added += 1;
      }
    }
    if (added === 0) {
      boneAction = 'Nothing further could be matched by name; the rest are yours to pair.';
      cleared = undefined;
      fillBones();
      return;
    }
    boneChanged(
      `${added} pairs suggested by name. Check them: a wrong pair is worse than an absent one.`,
    );
  });

  /** Redraw their muscles on our bones, through the bone pairs as they stand. */
  const doRetarget = (): void => {
    const name = ui.model.value;
    const model = overlay.model(name);
    const articulation = host.articulation();
    const list = bonesFor(name);
    // A second guard behind the disabled button, which says what is missing rather than nothing.
    if (!articulation) {
      ui.fitNote.textContent = START_NOTE;
      return;
    }
    if (!model) {
      ui.fitNote.textContent = 'Pick a reference model first: a redraw carries its muscles over.';
      return;
    }
    if (list.length === 0) {
      ui.fitNote.textContent =
        'Pair at least one of their bones with one of our segments first: a redraw goes through ' +
        'the bone pairs.';
      return;
    }
    // Read before the placement goes to neutral below. A bone with nothing fitted above it takes
    // the model's placement, so it keeps the turn that stood the model up rather than the
    // identity, which left it lying in their axes.
    const placedAt = beforeRetarget?.placement ?? placement();
    const result = fitBodies(
      model,
      list,
      articulation,
      (segment) => host.jointsOn(segment),
      fittedFromPlacement(placedAt),
    );
    const { fits } = result;
    const notBuilt = unbuilt(list);
    const paths = new Map<string, readonly number[]>();
    // A muscle is left out for one of two reasons, and they want different fixes: a bone it runs
    // over has no pair yet, or its pair names a segment this body was built without.
    let unpaired = 0;
    let absent = 0;
    for (const muscle of model.muscles) {
      const moved = retargetPath(muscle.path, muscle.on, fits);
      if (moved) paths.set(muscle.name, moved);
      else if (muscle.on.some((body) => notBuilt.has(body))) absent += 1;
      else unpaired += 1;
    }
    overlay.showRetargeted(paths);
    // Their bones go through the same fits, or the muscles end up floating beside a skeleton
    // they no longer belong to.
    overlay.retargetBones(fits, model.bodies);
    // Everything is in our space now, so the model transform must not move it again. The
    // sliders follow, rather than silently disagreeing with what is on screen. The person's
    // placement is kept first, and `??=` keeps the first redraw's when this is a second one.
    beforeRetarget ??= { model: name, placement: placement() };
    applyPlacement({ ...NEUTRAL_PLACEMENT });
    // A gizmo left on the model would move the redrawn drawing off our bones.
    if (gizmoTarget() === 'model') setGizmo('off');
    // A redraw nobody can see is the same as no redraw: whichever layer was off comes on.
    if (!ui.show.checked) ui.show.checked = true;
    overlay.visible = ui.show.checked;
    overlay.bonesVisible = ui.showBones.checked;
    settleGizmo();
    // What each fit rested on, because a fit from five matched joints and one that inherited its
    // parent's roll are not the same claim, and the note should not flatten them together.
    ui.fitNote.textContent =
      `${paths.size} of ${model.muscles.length} muscles redrawn on our bones` +
      (absent
        ? `; ${absent} left out, a bone they run over is paired with a segment not in this body`
        : '') +
      (unpaired ? `; ${unpaired} left out, a bone they run over is not paired yet` : '') +
      `. ${describeFits(result, model.bodies)}`;
  };
  ui.retarget.addEventListener('click', doRetarget);
  ui.saveBones.addEventListener('click', () => save('bones'));

  // ---- opening a file back in ----------------------------------------------------------
  /** What the reference data and the body can say about names, for a merge to check against. */
  const knownNames = (kind: 'muscles' | 'bones') => ({
    theirs: (model: string): ReadonlySet<string> | undefined => {
      const source = overlay.model(model);
      if (!source) return undefined;
      return new Set(
        kind === 'muscles' ? source.muscles.map((m) => m.name) : source.bodies.map((b) => b.name),
      );
    },
    ours: kind === 'muscles' ? ourUnits() : segmentIds(),
  });
  /** Where each list reports what opening a file did. */
  const noteOf: Record<Section, HTMLElement> = {
    pairs: ui.pairNote,
    bones: ui.boneNote,
    moves: ui.pointNote,
  };
  const SECTION_NAMES: Record<Section, string> = {
    pairs: 'Correspondence',
    bones: 'Bone pairing',
    moves: 'Our points',
  };
  /**
   * Take a file's text into whichever list it belongs to, and say what that did in that list's
   * note. Returns the list it landed in, or undefined when it could not be read.
   */
  const takeFile = (text: string, from: Section): Section | undefined => {
    const file = readAlignmentFile(text);
    if ('error' in file) {
      noteOf[from].textContent = `That file could not be opened: ${file.error}.`;
      return undefined;
    }
    let report: MergeReport;
    let section: Section;
    if (file.kind === 'correspondence') {
      section = 'pairs';
      report = mergePairs(pairs, file.pairs, knownNames('muscles'));
      fillPairs();
    } else if (file.kind === 'bones') {
      section = 'bones';
      cleared = undefined;
      report = mergeBonePairs(bonePairs, file.models, knownNames('bones'));
      boneAction = '';
      fillBones();
    } else {
      section = 'moves';
      report = mergeMoves(moves, file.moves);
      fillMoves();
      showPoints();
    }
    const rows = {
      pairs: { one: 'pair', many: 'pairs' },
      bones: { one: 'bone pair', many: 'bone pairs' },
      moves: { one: 'move', many: 'moves' },
    }[section];
    let line = describeMerge(
      report,
      rows,
      section === 'pairs' ? 'a muscle' : 'a bone',
      section === 'pairs' ? 'a unit' : 'a segment',
    );
    if (section === 'moves' && stale.length > 0) {
      line += ` ${stale.length} of the kept moves do not fit the points shown on this body.`;
    }
    if (section === 'bones') boneAction = line;
    noteOf[section].textContent = line;
    if (section !== from) {
      noteOf[from].textContent =
        `That was a ${rows.one} file; it went into ${SECTION_NAMES[section]}.`;
    }
    if (report.added + report.replaced > 0) changed(section);
    return section;
  };
  /** Ask the host for a file and take it, whichever of the three Open buttons asked. */
  const openFile = (from: Section): void => {
    host.open().then(
      (text) => {
        if (text !== undefined) takeFile(text, from);
      },
      (error: unknown) => {
        noteOf[from].textContent =
          `That file could not be read: ${error instanceof Error ? error.message : String(error)}.`;
      },
    );
  };
  ui.openPairs.addEventListener('click', () => openFile('pairs'));
  ui.openBones.addEventListener('click', () => openFile('bones'));
  ui.openMoves.addEventListener('click', () => openFile('moves'));
  /**
   * Opening waits for the reference data, because a file is checked against it: a pair naming a
   * muscle their model does not have is dropped, which cannot be decided before the model is here.
   */
  const setOpenable = (on: boolean): void => {
    for (const button of [ui.openPairs, ui.openBones, ui.openMoves]) button.disabled = !on;
  };
  setOpenable(false);

  /**
   * Bring back the draft the last visit left, when nothing has been done here yet.
   *
   * Through the same merge an opened file goes through, so a draft naming a muscle the reference
   * data no longer has is treated like such a file. Restored work is unsaved work: the lists are
   * marked unsaved, and leaving warns until each is saved.
   */
  const restoreDraft = (): string => {
    draftChecked = true;
    const empty =
      pairs.length === 0 &&
      moves.length === 0 &&
      [...bonePairs.values()].every((list) => list.length === 0);
    const draft = empty ? readDraft(memory) : undefined;
    if (!draft) return '';
    const p = mergePairs(pairs, draft.pairs, knownNames('muscles'));
    const b = mergeBonePairs(bonePairs, draft.bones, knownNames('bones'));
    const m = mergeMoves(moves, draft.moves);
    if (p.added) edits.pairs += 1;
    if (b.added) edits.bones += 1;
    if (m.added) edits.moves += 1;
    fillPairs();
    fillBones();
    fillMoves();
    showPoints();
    return (
      ` Restored the draft from your last visit: ${p.added} pairs, ${b.added} bone pairs and ` +
      `${m.added} moves, none of them saved to a file yet.`
    );
  };

  /** The reference sites as the tab loads them: once, when it is first opened. */
  let sites: Promise<void> | undefined;
  /**
   * Fetch the reference sites the first time the tab is opened, and not before.
   *
   * A studio nobody aligns anything in never pays for them. A failed load is said in the model
   * note and forgotten, so opening the tab again asks again -- after the file has been
   * regenerated, say.
   */
  const ensureSites = (): Promise<void> => {
    if (adopted) return Promise.resolve();
    if (!sites) {
      idleNote = { text: 'Loading reference models…', error: false };
      writeModelNote();
      sites = fetchSourceSites().then((result) => {
        if ('data' in result) {
          adopt(result.data);
        } else {
          sites = undefined;
          unavailable(result.error);
        }
      });
    }
    return sites;
  };
  const adopt = (data: SourceSites): void => {
    if (data === adopted) return;
    adopted = data;
    sourceStamp = provenanceOf.get(data);
    overlay.load(data);
    ui.model.innerHTML = '<option value="">None</option>';
    for (const name of overlay.models) {
      const option = document.createElement('option');
      option.value = name;
      const n = overlay.muscles(name).length;
      option.textContent = `${name} — ${n} muscles`;
      ui.model.appendChild(option);
    }
    ui.model.disabled = false;
    setOpenable(true);
    const restored = draftChecked ? '' : restoreDraft();
    idleNote = {
      text: `${overlay.models.length} reference models loaded.${restored}`,
      error: false,
    };
    showModel();
  };
  const unavailable = (reason: string): void => {
    idleNote = {
      text:
        `Reference models could not be loaded (sourceSites.json: ${reason}). Regenerate it with ` +
        'pnpm generate:source-sites.',
      error: true,
    };
    ui.model.disabled = true;
    if (!adopted) ui.model.value = '';
    writeModelNote();
  };

  fillOurs();
  fillPairs();
  fillMoves();
  fillOurBones();
  fillBones();
  writeSliders(placement());
  settleGizmo();
  showPicked();
  syncReadiness();

  const setActive = (on: boolean): void => {
    if (on === active) return;
    active = on;
    if (!on) {
      const target = gizmoTarget();
      parked = target === 'off' ? undefined : { target, mode: gizmo.mode as GizmoMode };
      setGizmo('off');
      gizmo.enabled = false;
      host.setGizmoDragging(false);
      host.highlightSegment(undefined);
      // Hidden outside this tab by default, the reference overlay included: it is a comparison
      // with our body, and elsewhere there is nothing being compared.
      overlay.visible = false;
      overlay.bonesVisible = false;
      handles.visible = false;
      // Another tab sees the run as it is; nothing there is judged against the rest pose.
      host.holdRest(false);
      return;
    }
    gizmo.enabled = true;
    void ensureSites();
    const model = ui.model.value !== '';
    overlay.visible = ui.show.checked && model;
    overlay.bonesVisible = ui.showBones.checked && model;
    handles.visible = ui.points.value !== '' && host.articulation() !== undefined;
    syncHold();
    host.highlightSegment(highlighted);
    // The proxy only means something while the point it stood for is still picked: a rebuild
    // while the tab was closed redraws the handles and forgets the pick. The model only while
    // there is still a model on screen to hold.
    if (
      (parked?.target === 'model' && modelMovable()) ||
      (parked?.target === 'point' && handles.pickedHandle)
    ) {
      setGizmo(parked.target, parked.mode);
    }
    parked = undefined;
  };
  // The tabs announce themselves; a panel built after the first announcement reads its own
  // section for where the studio opened, in `attach`.
  const onTab = (event: Event): void =>
    setActive((event as CustomEvent<string>).detail === 'align');
  document.addEventListener(TAB_CHANGE, onTab);

  return {
    overGizmo(): boolean {
      return active && gizmo.object !== undefined && gizmo.axis !== null;
    },
    pickPoint,
    setActive,
    attach(world: Object3D): void {
      world.add(overlay.group);
      world.add(overlay.bones);
      world.add(handles.group);
      world.add(proxy);
      const helper = (gizmo as unknown as { getHelper?: () => Object3D }).getHelper?.();
      if (helper) world.parent?.add(helper);
      // A studio that reopens on this tab announced it before the panel was listening.
      const section = document.querySelector<HTMLElement>('[data-panel="align"]');
      setActive(section !== null && !section.hidden);
    },
    adopt,
    unavailable,
    refresh(): void {
      fillOurs();
      // The body is a new one: its segments, and which bone pairs it has no segment for.
      fillOurBones();
      fillBones();
      // Which pairs name a unit this body lacks.
      fillPairs();
      // Every model nobody has placed by hand sits down on the new body.
      reseat();
      showPoints();
      syncReadiness();
      writeModelNote();
    },
    dispose(): void {
      window.removeEventListener('click', onClick, { capture: true });
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener(TAB_CHANGE, onTab);
      host.highlightSegment(undefined);
      host.holdRest(false);
      overlay.dispose();
      handles.dispose();
      gizmo.detach();
      gizmo.dispose();
    },
  };
}

/** The reference sites as fetched: the data and what identifies it, or why there is none. */
export type SourceSitesLoad =
  | { readonly data: SourceSites; readonly stamp: SourceSitesStamp }
  | { readonly error: string };

/**
 * Which extraction each loaded copy of the reference sites is, by the object it was parsed into.
 *
 * Kept beside the data rather than in it, so `SourceSites` stays the shape the generator writes,
 * and so whoever hands the data to `adopt` hands its provenance with it without knowing about it.
 */
const provenanceOf = new WeakMap<SourceSites, SourceSitesStamp>();

/** The first fetch's outcome, for `loadSourceSites`: settled when the tab first loads them. */
let settleFirstLoad: ((load: SourceSitesLoad) => void) | undefined;
const firstLoad = new Promise<SourceSitesLoad>((resolve) => {
  settleFirstLoad = resolve;
});

/**
 * Fetch the extracted reference sites, or say why they could not be had.
 *
 * Fetched rather than bundled: it is a hundred kilobytes of authoring data that only the Align tab
 * reads, and the panel asks for it the first time that tab is opened, so every other visit to the
 * studio never carries it. The file is written by `pnpm generate:source-sites`; a failure names
 * the HTTP status or the exception, which is what regenerating it or serving it will fix. Read as
 * text before it is parsed, because the digest in every saved file's provenance is of the file's
 * own bytes.
 */
export async function fetchSourceSites(): Promise<SourceSitesLoad> {
  let load: SourceSitesLoad;
  try {
    // Not force-cached: this file is regenerated by `pnpm generate:source-sites` whenever the
    // vendored models are re-read, and a stale copy is indistinguishable from a broken one.
    const response = await fetch('sourceSites.json', { cache: 'no-cache' });
    if (!response.ok) {
      load = {
        error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      };
    } else {
      const text = await response.text();
      const data = JSON.parse(text) as SourceSites;
      if (typeof data !== 'object' || data === null || typeof data.models !== 'object') {
        load = { error: 'it is not a set of reference models' };
      } else {
        const stamp = { format: String(data.format), digest: fnv1a32(text) };
        provenanceOf.set(data, stamp);
        load = { data, stamp };
      }
    }
  } catch (error) {
    load = { error: error instanceof Error ? error.message : String(error) };
  }
  settleFirstLoad?.(load);
  settleFirstLoad = undefined;
  return load;
}

/**
 * The reference sites, once the Align tab has loaded them; undefined if that load failed.
 *
 * This does not fetch anything. The panel loads the sites itself the first time its tab is
 * opened, and this settles with that first load, so a caller that adopts what it returns -- the
 * studio's entry file does -- hands the panel the data it already has, which `adopt` ignores. That
 * caller is redundant now and can go; it is kept working rather than broken because the entry file
 * is not this module's to change.
 */
export async function loadSourceSites(): Promise<SourceSites | undefined> {
  const load = await firstLoad;
  return 'data' in load ? load.data : undefined;
}
