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
import { Object3D } from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DRAG_THRESHOLD } from '../orbit.js';
import { TAB_CHANGE } from '../ui/tabs.js';
import { type Move, PointHandles } from './pointHandles.js';
import { type BodyPair, fitBodies, retargetPath, suggestBodyPairs } from './retarget.js';
import {
  NEUTRAL as NEUTRAL_PLACEMENT,
  type Placement,
  SourceOverlay,
  type SourceSites,
  Z_UP_TO_Y_UP,
} from './sourceOverlay.js';

export interface Pair {
  /** Their muscle, by the name the reference model gives it. */
  readonly theirs: string;
  /** Which reference model it came from. */
  readonly model: string;
  /** Our unit id. */
  readonly ours: string;
}

export interface AlignHost {
  /** The compiled body as it stands, or undefined before a run is built. */
  articulation(): CompiledArticulation | undefined;
  /** Our muscle unit ids, for the right-hand list. */
  units(): readonly string[];
  /**
   * Our joints touching a segment: where each sits at rest, and the segment on the other side.
   *
   * The other side is what lets a joint of theirs be matched to one of ours -- both models agree
   * a hip is a hip, so the joint between two paired bones is the same joint in both.
   */
  jointsOn(segment: string): readonly {
    at: import('three').Vector3;
    other: string;
    /** The joint's own hinge axes in the world, for settling a bone's roll. */
    axes: import('three').Vector3[];
  }[];
  /** Attachment sites in the world at rest. */
  sites(): readonly { id: string; bone: string; world: { x: number; y: number; z: number } }[];
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
  /** What the gizmo held when the tab was left, handed back when it returns. */
  let parked: Object3D | undefined;
  // A gizmo drag must not also orbit the camera, and three's own event says when it starts.
  gizmo.addEventListener('dragging-changed', (event) => {
    host.setGizmoDragging((event as unknown as { value: boolean }).value);
  });

  const ui = {
    model: must<HTMLSelectElement>('#align-model'),
    show: must<HTMLInputElement>('#align-show'),
    showBones: must<HTMLInputElement>('#align-show-bones'),
    modelNote: must<HTMLElement>('#align-model-note'),
    grab: must<HTMLButtonElement>('#align-grab'),
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

  let placement: Placement = { ...Z_UP_TO_Y_UP };
  const pairs: Pair[] = [];
  const moves: Move[] = [];
  /** Whether the overlay is currently on our bones rather than in their own world. */
  let retargeted = false;
  /** Bone pairs per model, because each reference model has its own bones. */
  const bonePairs = new Map<string, BodyPair[]>();
  const bonesFor = (model: string): BodyPair[] => {
    const list = bonePairs.get(model) ?? [];
    bonePairs.set(model, list);
    return list;
  };

  // ---- the reference model --------------------------------------------------------------
  const readSliders = (): Placement => ({
    x: Number(slider('x').value),
    y: Number(slider('y').value),
    z: Number(slider('z').value),
    rx: Number(slider('rx').value),
    ry: Number(slider('ry').value),
    rz: Number(slider('rz').value),
    scale: Number(slider('scale').value),
  });
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
    placement = p;
    overlay.place(p);
    writeSliders(p);
  };
  for (const key of PLACE) {
    slider(key).addEventListener('input', () => {
      // Moving the whole model once it is on our bones would take it back off them, so the
      // first nudge of a slider drops the retarget and puts their own geometry back.
      if (retargeted) {
        retargeted = false;
        showModel();
      }
      applyPlacement(readSliders());
    });
  }
  ui.reset.addEventListener('click', () => applyPlacement({ ...Z_UP_TO_Y_UP }));

  const showModel = (): void => {
    const model = ui.model.value;
    retargeted = false;
    overlay.clear();
    if (model) overlay.show(model);
    overlay.visible = ui.show.checked && model !== '';
    if (model) overlay.showBones(model);
    overlay.bonesVisible = ui.showBones.checked && model !== '';
    overlay.place(placement);
    const n = overlay.muscles(model).length;
    ui.modelNote.textContent = model
      ? `${n} muscles on the reference ${model}, and its bones. Turn either on to compare.`
      : 'No reference model shown.';
    fillTheirs();
    fillBones();
  };
  ui.model.addEventListener('change', showModel);
  ui.show.addEventListener('change', () => {
    overlay.visible = ui.show.checked && ui.model.value !== '';
  });
  ui.showBones.addEventListener('change', () => {
    overlay.bonesVisible = ui.showBones.checked && ui.model.value !== '';
  });
  ui.grab.addEventListener('click', () => {
    if (!overlay.visible && !overlay.bonesVisible) return;
    gizmo.attach(overlay.group);
    gizmo.setMode(gizmo.mode === 'translate' ? 'rotate' : 'translate');
    ui.grab.textContent = `Gizmo: ${gizmo.mode}`;
  });
  // When the gizmo has moved the overlay, the sliders have to agree with it.
  gizmo.addEventListener('objectChange', () => {
    if (gizmo.object === overlay.group) {
      // `place` moves the bones with the muscles, so reading one and applying both keeps the
      // skeleton and its muscles together under the gizmo.
      applyPlacement(overlay.readPlacement());
    } else if (gizmo.object && handles.pickedHandle) {
      handles.moveTo(gizmo.object.position.clone());
      showPicked();
    }
  });

  // ---- correspondence -------------------------------------------------------------------
  const pairedTheirs = () => new Set(pairs.map((p) => `${p.model}/${p.theirs}`));
  const fillTheirs = (): void => {
    const model = ui.model.value;
    const filter = ui.theirsFind.value.trim().toLowerCase();
    const done = pairedTheirs();
    const list = overlay
      .muscles(model)
      .filter((m) => !filter || m.name.toLowerCase().includes(filter));
    ui.theirs.innerHTML = '';
    for (const m of list) {
      const option = document.createElement('option');
      option.value = m.name;
      const paired = done.has(`${model}/${m.name}`);
      option.textContent = `${paired ? '· ' : ''}${m.name}  (${m.bodies.join(' → ')})`;
      ui.theirs.appendChild(option);
    }
    ui.theirsCount.textContent = `${list.length}`;
    overlay.markPaired(new Set([...done].map((k) => k.split('/')[1] as string)));
  };
  const fillOurs = (): void => {
    const filter = ui.oursFind.value.trim().toLowerCase();
    const list = host.units().filter((u) => !filter || u.toLowerCase().includes(filter));
    ui.ours.innerHTML = '';
    for (const u of list) {
      const option = document.createElement('option');
      option.value = u;
      option.textContent = u;
      ui.ours.appendChild(option);
    }
    ui.oursCount.textContent = `${list.length}`;
  };
  ui.theirsFind.addEventListener('input', fillTheirs);
  ui.oursFind.addEventListener('input', fillOurs);
  const refreshPairButton = (): void => {
    ui.pair.disabled = !(ui.theirs.value && ui.ours.value);
  };
  ui.theirs.addEventListener('change', () => {
    overlay.emphasise(ui.theirs.value || undefined);
    refreshPairButton();
  });
  ui.ours.addEventListener('change', refreshPairButton);

  const fillPairs = (): void => {
    ui.pairs.innerHTML = '';
    for (const p of pairs) {
      const option = document.createElement('option');
      option.value = `${p.model}/${p.theirs}`;
      option.textContent = `${p.theirs}  →  ${p.ours}`;
      ui.pairs.appendChild(option);
    }
    ui.pairsCount.textContent = `${pairs.length}`;
    ui.unpair.disabled = pairs.length === 0;
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
    const key = ui.pairs.value;
    const at = pairs.findIndex((p) => `${p.model}/${p.theirs}` === key);
    if (at >= 0) {
      const [gone] = pairs.splice(at, 1);
      ui.pairNote.textContent = gone ? `${gone.theirs} is no longer paired.` : '';
      fillPairs();
    }
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
      gizmo.detach();
      showPicked();
      return;
    }
    handles.show(
      kind === 'joints' ? PointHandles.jointsOf(model) : PointHandles.sitesOf(model, host.sites()),
    );
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
    gizmo.attach(proxy);
    gizmo.setMode('translate');
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
  const fillBoneLists = (): void => {
    const model = overlay.model(ui.model.value);
    const done = new Set(bonesFor(ui.model.value).map((p) => p.theirs));
    ui.theirBone.innerHTML = '';
    for (const body of model?.bodies ?? []) {
      const option = document.createElement('option');
      option.value = body.name;
      option.textContent = `${done.has(body.name) ? '· ' : ''}${body.name}`;
      ui.theirBone.appendChild(option);
    }
    ui.ourBone.innerHTML = '';
    for (const seg of host.articulation()?.segments ?? []) {
      const option = document.createElement('option');
      option.value = seg.id;
      option.textContent = seg.id;
      ui.ourBone.appendChild(option);
    }
  };
  const fillBones = (): void => {
    const list = bonesFor(ui.model.value);
    ui.bones.innerHTML = '';
    for (const p of list) {
      const option = document.createElement('option');
      option.value = p.theirs;
      option.textContent = `${p.theirs}  →  ${p.ours}`;
      ui.bones.appendChild(option);
    }
    ui.bonesCount.textContent = `${list.length}`;
    ui.unpairBone.disabled = list.length === 0;
    ui.retarget.disabled = list.length === 0;
    fillBoneLists();
  };
  const refreshBoneButton = (): void => {
    ui.pairBone.disabled = !(ui.theirBone.value && ui.ourBone.value);
  };
  ui.theirBone.addEventListener('change', () => {
    overlay.emphasiseBone(ui.theirBone.value || undefined);
    refreshBoneButton();
  });
  ui.ourBone.addEventListener('change', () => {
    highlighted = ui.ourBone.value || undefined;
    host.highlightSegment(highlighted);
    refreshBoneButton();
  });
  ui.pairBone.addEventListener('click', () => {
    const theirs = ui.theirBone.value;
    const ours = ui.ourBone.value;
    if (!theirs || !ours) return;
    const list = bonesFor(ui.model.value);
    const at = list.findIndex((p) => p.theirs === theirs);
    // One of their bones sits on exactly one of ours, so a second pairing replaces the first.
    if (at >= 0) list.splice(at, 1, { theirs, ours });
    else list.push({ theirs, ours });
    ui.boneNote.textContent = `${theirs} → ${ours}.`;
    fillBones();
  });
  ui.unpairBone.addEventListener('click', () => {
    const list = bonesFor(ui.model.value);
    const at = list.findIndex((p) => p.theirs === ui.bones.value);
    if (at >= 0) {
      list.splice(at, 1);
      fillBones();
    }
  });
  ui.clearBones.addEventListener('click', () => {
    bonePairs.set(ui.model.value, []);
    ui.boneNote.textContent = 'Bone pairs cleared.';
    showModel();
    fillBones();
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
    ui.boneNote.textContent = added
      ? `${added} pairs suggested by name. Check them: a wrong pair is worse than an absent one.`
      : 'Nothing further could be matched by name; the rest are yours to pair.';
    fillBones();
  });

  /** Redraw their muscles on our bones, through the bone pairs as they stand. */
  const doRetarget = (): void => {
    const model = overlay.model(ui.model.value);
    const articulation = host.articulation();
    const list = bonesFor(ui.model.value);
    if (!model || !articulation || list.length === 0) return;
    const fits = fitBodies(model, list, articulation, (segment) => host.jointsOn(segment));
    const paths = new Map<string, readonly number[]>();
    let dropped = 0;
    for (const muscle of model.muscles) {
      const moved = retargetPath(muscle.path, muscle.on, fits);
      if (moved) paths.set(muscle.name, moved);
      else dropped += 1;
    }
    overlay.showRetargeted(paths);
    // Their bones go through the same fits, or the muscles end up floating beside a skeleton
    // they no longer belong to.
    overlay.retargetBones(fits, model.bodies);
    // Everything is in our space now, so the model transform must not move it again. The
    // sliders follow, rather than silently disagreeing with what is on screen.
    applyPlacement({ ...NEUTRAL_PLACEMENT });
    retargeted = true;
    // A redraw nobody can see is the same as no redraw: whichever layer was off comes on.
    if (!ui.show.checked) {
      ui.show.checked = true;
      overlay.visible = true;
    }
    overlay.visible = ui.show.checked;
    overlay.bonesVisible = ui.showBones.checked;
    // What each fit rested on, because a fit from five matched joints and one that inherited its
    // parent's roll are not the same claim, and the note should not flatten them together.
    const all = [...fits.values()];
    const full = all.filter((f) => f.kind === 'kabsch');
    const axis = all.filter((f) => f.kind.startsWith('axis and'));
    const inherited = all.filter((f) => f.kind === 'inherited' || f.kind === 'model');
    const ratios = all.map((f) => f.scale).sort((a, b) => a - b);
    const residuals = full.map((f) => f.residual ?? 0).sort((a, b) => a - b);
    ui.fitNote.textContent =
      `${paths.size} of ${model.muscles.length} muscles redrawn on our bones` +
      (dropped ? `; ${dropped} left out, a bone they run over is not paired yet` : '') +
      `. ${full.length} bones fitted from three joints or more` +
      (residuals.length
        ? ` (worst ${(residuals[residuals.length - 1] as number).toFixed(1)} mm out)`
        : '') +
      (axis.length ? `, ${axis.length} from two with the roll off the hinges` : '') +
      (inherited.length ? `, ${inherited.length} inherited whole` : '') +
      (ratios.length
        ? `. Scale ${(ratios[0] as number).toFixed(2)}x to ` +
          `${(ratios[ratios.length - 1] as number).toFixed(2)}x, ` +
          `median ${(ratios[Math.floor(ratios.length / 2)] as number).toFixed(2)}x.`
        : '.');
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
  fillBones();
  writeSliders(placement);

  const setActive = (on: boolean): void => {
    if (on === active) return;
    active = on;
    if (!on) {
      parked = gizmo.object;
      gizmo.detach();
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
    // while the tab was closed redraws the handles and forgets the pick.
    if (parked === overlay.group || (parked === proxy && handles.pickedHandle)) {
      gizmo.attach(parked);
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
      showPoints();
    },
    dispose(): void {
      window.removeEventListener('click', onClick, { capture: true });
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
    // Not force-cached: this file is regenerated by `pnpm extract:source-sites` whenever the
    // vendored models are re-read, and a stale copy is indistinguishable from a broken one.
    const response = await fetch('sourceSites.json', { cache: 'no-cache' });
    if (!response.ok) return undefined;
    return (await response.json()) as SourceSites;
  } catch {
    return undefined;
  }
}
