/**
 * The Align tab: bring the two bodies into register, decide which muscle is which, and move the
 * points of ours that are wrong.
 *
 * Three jobs that share a viewport, because they are the same act of looking. The reference model
 * has to be placed before anything on it can be compared; the comparison is what the pairing is
 * made from; and a point that turns out to be misplaced is found the same way, by looking at it
 * against the bone it sits on.
 *
 * What comes out is two files, both with their provenance on them: a correspondence mapping that
 * says who decided each row, and a set of point overrides that record how far each point moved
 * and why. Neither is written by guesswork and neither is applied automatically -- they are
 * proposals a person made, for a generator to consume.
 */

import type { CompiledArticulation } from '@bs-humany/compiler';
import type { Camera, WebGLRenderer } from 'three';
import { MathUtils, Object3D } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DRAG_THRESHOLD } from '../orbit.js';
import { keyOwnedByTarget } from '../shortcuts.js';
import { TAB_CHANGE } from '../ui/tabs.js';
import { type Pair, missingSegments, pairLabel, pairedIn, unpairAt } from './correspondence.js';
import { describeFits } from './fit.js';
import { type Move, PointHandles } from './pointHandles.js';
import {
  type BodyPair,
  fitBodies,
  fittedFromPlacement,
  retargetPath,
  suggestBodyPairs,
} from './retarget.js';
import {
  NEUTRAL as NEUTRAL_PLACEMENT,
  type Placement,
  SourceOverlay,
  type SourceSites,
  changeOfAxes,
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
  /** Hand a file to the user, however this studio does that. */
  save(name: string, text: string): void;
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
  /** Take the reference sites once they have been fetched. */
  adopt(data: SourceSites): void;
  /** Called when the body is rebuilt, so the handles follow it. */
  refresh(): void;
  dispose(): void;
}

/** What the gizmo holds: nothing, the whole reference model, or the picked point of ours. */
type GizmoTarget = 'off' | 'model' | 'point';
/** Moving or turning. Scaling is left out: a placement has one uniform scale, and its slider. */
type GizmoMode = 'translate' | 'rotate';

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
    points: must<HTMLSelectElement>('#align-points'),
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
    moves: must<HTMLSelectElement>('#align-moves'),
    movesCount: must<HTMLOutputElement>('#align-moves-count'),
    saveMoves: must<HTMLButtonElement>('#align-save-moves'),
  };
  const slider = (id: string) => must<HTMLInputElement>(`#align-${id}`);
  const PLACE: (keyof Placement)[] = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'scale'];

  /**
   * Where each reference model has been put, by model.
   *
   * One placement for all of them meant a model picked after another arrived in the last one's
   * turn and place, and a Z-up model and a Y-up one need different turns just to stand up. So
   * each model keeps its own, starting from its own change of axes the first time it is asked
   * for, and going back to a model finds it where it was left.
   */
  const placements = new Map<string, Placement>();
  const placementOf = (model: string): Placement => {
    let p = placements.get(model);
    if (!p) {
      p = changeOfAxes(model);
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
  /** Bone pairs per model, because each reference model has its own bones. */
  const bonePairs = new Map<string, BodyPair[]>();
  const bonesFor = (model: string): BodyPair[] => {
    const list = bonePairs.get(model) ?? [];
    bonePairs.set(model, list);
    return list;
  };
  /**
   * The bone pairs Clear bone pairs took away, while they can still be put back.
   *
   * Clearing is undone by a second click rather than asked about first, because a confirmation
   * dialog is not dependable in the desktop shell's webview, and because nothing else would bring
   * them back: bone pairs are saved to a file but never read back from one. Anything that changes
   * the pairs since -- a pair, an unpair, a suggestion, another model -- makes the old list a
   * different decision, and the chance to restore it goes.
   */
  let cleared: { model: string; list: BodyPair[] } | undefined;

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
   * redraw the way a slider does and starts from the placement the person gave it.
   */
  const grabModel = (mode: GizmoMode): void => {
    if (!modelMovable()) return;
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
      applyPlacement({ ...placement(), [key]: value });
    });
  }
  // The model's own change of axes, not one shared by all: a Z-up model and a Y-up one need
  // different turns to stand up in ours, and one turn for both laid the arm on the floor.
  ui.reset.addEventListener('click', () => {
    if (beforeRetarget) showModel();
    applyPlacement(changeOfAxes(ui.model.value));
  });

  /** What the model note says: what is shown, and why the gizmo cannot take it if it cannot. */
  const writeModelNote = (): void => {
    const model = ui.model.value;
    if (!model) {
      ui.modelNote.textContent = 'No reference model shown. Pick one to place it or pair with it.';
      return;
    }
    const n = overlay.muscles(model).length;
    ui.modelNote.textContent = modelMovable()
      ? `${n} muscles on the reference ${model}, and its bones. Turn either on to compare.`
      : `${n} muscles on the reference ${model}, and its bones. Turn either on to compare, ` +
        'and to move it with the gizmo.';
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
    overlay.clear();
    if (model) overlay.show(model);
    overlay.visible = active && ui.show.checked && model !== '';
    if (model) overlay.showBones(model);
    overlay.bonesVisible = active && ui.showBones.checked && model !== '';
    overlay.place(placement());
    writeSliders(placement());
    // Lets go of the model when there is none, and leaves a gizmo on a point of ours alone.
    settleGizmo();
    fillTheirs();
    fillBones();
  };
  // A model picked for the first time starts from its own change of axes, and one picked before
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
      applyPlacement(overlay.readPlacement());
    } else if (gizmo.object && handles.pickedHandle) {
      handles.moveTo(gizmo.object.position.clone());
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
    // A row is found again by its place in the list: one of theirs may be paired with several of
    // ours, so their muscle alone does not say which row was picked.
    refill(
      ui.pairs,
      pairs.map((p, i) => ({ value: String(i), label: pairLabel(p) })),
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
  });
  ui.savePairs.addEventListener('click', () => {
    host.save(
      'sourceCorrespondence.json',
      `${JSON.stringify(
        {
          format: 'bs-humany.source-correspondence/1',
          decidedAt: new Date().toISOString(),
          note:
            'Which muscle of the reference models is which of ours. Decided by eye in the studio ' +
            'Align tab; many of theirs may map to one of ours. Consumed by measure:source-travel.',
          pairs,
        },
        null,
        2,
      )}\n`,
    );
  });

  // ---- our points -----------------------------------------------------------------------
  const showPicked = (): void => {
    const h = handles.pickedHandle;
    if (!h) {
      ui.pointNote.textContent = 'No point picked.';
      ui.keep.disabled = true;
      ui.revert.disabled = true;
      return;
    }
    const moved = 1000 * h.world.distanceTo(h.original);
    ui.pointNote.textContent =
      `${h.id} on ${h.on} — ` +
      `${h.world.x.toFixed(4)}, ${h.world.y.toFixed(4)}, ${h.world.z.toFixed(4)}` +
      (moved > 0.01 ? `  ·  moved ${moved.toFixed(1)} mm` : '');
    ui.keep.disabled = moved <= 0.01 || ui.reason.value.trim() === '';
    ui.revert.disabled = moved <= 0.01;
  };
  ui.reason.addEventListener('input', showPicked);

  const showPoints = (): void => {
    const kind = ui.points.value;
    const model = host.articulation();
    if (!kind || !model) {
      handles.clear();
      handles.visible = false;
      // Only a gizmo on a point lets go: the model's gizmo has nothing to do with the points.
      if (gizmoTarget() === 'point') setGizmo('off');
      showPicked();
      return;
    }
    handles.show(
      kind === 'joints' ? PointHandles.jointsOf(model) : PointHandles.sitesOf(model, host.sites()),
    );
    // Redrawing the handles forgets the pick, so a gizmo left on it would move nothing.
    if (gizmoTarget() === 'point' && !handles.pickedHandle) setGizmo('off');
    // Not simply on: a rebuild in another tab runs this too (`refresh`), and must not bring the
    // handles back into a viewport that is not aligning anything.
    handles.visible = active;
    ui.pointNote.textContent = `${handles.all.length} ${kind === 'joints' ? 'joint centres' : 'attachment sites'}. Click one in the viewport.`;
  };
  ui.points.addEventListener('change', showPoints);

  // Picking: the handle drawn nearest the pointer, measured on the screen.
  //
  // The gizmo drives an empty that the picked handle follows, because the handles are one Points
  // cloud and a cloud has no node per point for a gizmo to attach to.
  const proxy = new Object3D();
  proxy.name = 'align-gizmo-proxy';
  const pickPoint = (clientX: number, clientY: number): boolean => {
    // Over a gizmo handle the press belongs to the gizmo, not to picking a new point.
    if (!active || !handles.visible || gizmo.axis !== null || gizmo.dragging) return false;
    const rect = renderer.domElement.getBoundingClientRect();
    const at = handles.nearestOnScreen(camera, rect, clientX, clientY);
    if (at < 0) return false;
    const h = handles.pick(at);
    if (!h) return false;
    proxy.position.copy(h.world);
    setGizmo('point', 'translate');
    showPicked();
    return true;
  };

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
    const at = moves.findIndex((m) => m.id === move.id);
    if (at >= 0) moves.splice(at, 1, move);
    else moves.push(move);
    ui.reason.value = '';
    fillMoves();
    showPicked();
  });
  ui.revert.addEventListener('click', () => {
    const h = handles.revert();
    if (!h) return;
    const at = moves.findIndex((m) => m.id === h.id);
    if (at >= 0) moves.splice(at, 1);
    // The gizmo stays on the point, which is back where it started, so the gizmo goes with it.
    proxy.position.copy(h.world);
    fillMoves();
    showPicked();
  });
  const fillMoves = (): void => {
    ui.moves.innerHTML = '';
    for (const m of moves) {
      const option = document.createElement('option');
      option.value = m.id;
      option.textContent = `${m.id}  ${m.moved.toFixed(1)} mm`;
      ui.moves.appendChild(option);
    }
    ui.movesCount.textContent = `${moves.length}`;
  };
  ui.saveMoves.addEventListener('click', () => {
    host.save(
      'pointOverrides.json',
      `${JSON.stringify(
        {
          format: 'bs-humany.point-overrides/1',
          decidedAt: new Date().toISOString(),
          note:
            'Points moved by eye in the studio Align tab, judged against our own meshes. The ' +
            'reference model is context and was never the target. Each carries how far it moved ' +
            'and why.',
          moves,
        },
        null,
        2,
      )}\n`,
    );
  });

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
  const unbuilt = (list: readonly BodyPair[]): Set<string> => {
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
    ui.retarget.disabled = list.length === 0;
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
        label: `${p.theirs}  →  ${p.ours}${missing.has(p.theirs) ? ' (not in this body)' : ''}`,
      })),
    );
    fillTheirBones();
  };
  /** Say what a bone pairing action did, and forget any clear that could still be restored. */
  const boneChanged = (note: string): void => {
    boneAction = note;
    cleared = undefined;
    fillBones();
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
    // One of their bones sits on exactly one of ours, so a second pairing replaces the first.
    if (at >= 0) list.splice(at, 1, { theirs, ours });
    else list.push({ theirs, ours });
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
      return;
    }
    const list = bonesFor(model);
    if (list.length === 0) return;
    cleared = { model, list };
    bonePairs.set(model, []);
    boneAction = `${list.length} bone pairs cleared. Click Restore to put them back.`;
    // A redraw made from the pairs is dropped with them; `showModel` redraws the list as well.
    showModel();
  });
  ui.suggest.addEventListener('click', () => {
    const model = overlay.model(ui.model.value);
    const articulation = host.articulation();
    if (!model || !articulation) return;
    const suggested = suggestBodyPairs(
      model,
      articulation.segments.map((s) => s.id),
    );
    const list = bonesFor(ui.model.value);
    let added = 0;
    for (const p of suggested) {
      if (!list.some((existing) => existing.theirs === p.theirs)) {
        list.push(p);
        added += 1;
      }
    }
    boneChanged(
      added
        ? `${added} pairs suggested by name. Check them: a wrong pair is worse than an absent one.`
        : 'Nothing further could be matched by name; the rest are yours to pair.',
    );
  });

  /** Redraw their muscles on our bones, through the bone pairs as they stand. */
  const doRetarget = (): void => {
    const name = ui.model.value;
    const model = overlay.model(name);
    const articulation = host.articulation();
    const list = bonesFor(name);
    if (!model || !articulation || list.length === 0) return;
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
  ui.saveBones.addEventListener('click', () => {
    host.save(
      'bonePairing.json',
      `${JSON.stringify(
        {
          format: 'bs-humany.bone-pairing/1',
          decidedAt: new Date().toISOString(),
          note:
            'Which bone of each reference model is which of ours. A pair fixes an origin and an ' +
            'orientation; the joints on that bone give it a scale. Decided by eye in the studio ' +
            'Align tab.',
          models: Object.fromEntries([...bonePairs].filter(([, v]) => v.length > 0)),
        },
        null,
        2,
      )}\n`,
    );
  });

  fillOurs();
  fillPairs();
  fillMoves();
  fillOurBones();
  fillBones();
  writeSliders(placement());
  settleGizmo();

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
      return;
    }
    gizmo.enabled = true;
    const model = ui.model.value !== '';
    overlay.visible = ui.show.checked && model;
    overlay.bonesVisible = ui.showBones.checked && model;
    handles.visible = ui.points.value !== '' && host.articulation() !== undefined;
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
    adopt(data: SourceSites): void {
      overlay.load(data);
      ui.model.innerHTML = '<option value="">None</option>';
      for (const name of overlay.models) {
        const option = document.createElement('option');
        option.value = name;
        const n = overlay.muscles(name).length;
        option.textContent = `${name} — ${n} muscles`;
        ui.model.appendChild(option);
      }
      ui.modelNote.textContent = `${overlay.models.length} reference models loaded.`;
    },
    refresh(): void {
      fillOurs();
      // The body is a new one: its segments, and which bone pairs it has no segment for.
      fillOurBones();
      fillBones();
      showPoints();
    },
    dispose(): void {
      window.removeEventListener('click', onClick, { capture: true });
      window.removeEventListener('keydown', onKey);
      document.removeEventListener(TAB_CHANGE, onTab);
      host.highlightSegment(undefined);
      overlay.dispose();
      handles.dispose();
      gizmo.detach();
      gizmo.dispose();
    },
  };
}

/**
 * Load the extracted reference sites.
 *
 * Fetched rather than bundled: it is a hundred kilobytes of authoring data that only this tab
 * reads, and every other viewer of the studio would otherwise carry it for nothing.
 */
export async function loadSourceSites(): Promise<SourceSites | undefined> {
  try {
    // Not force-cached: this file is regenerated by `pnpm generate:source-sites` whenever the
    // vendored models are re-read, and a stale copy is indistinguishable from a broken one.
    const response = await fetch('sourceSites.json', { cache: 'no-cache' });
    if (!response.ok) return undefined;
    return (await response.json()) as SourceSites;
  } catch {
    return undefined;
  }
}
