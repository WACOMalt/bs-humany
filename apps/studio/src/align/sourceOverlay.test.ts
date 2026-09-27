/**
 * The reference overlay's loading and styling, driven by hand.
 *
 * Every fetch is held until the test lets it go, so the orders that went wrong in the studio --
 * a second model picked while the first is still arriving, a retarget or a teardown in the middle
 * of a load -- can be played out one step at a time instead of hoped for on a slow connection.
 */

import {
  BufferGeometry,
  Euler,
  type LineBasicMaterial,
  LineSegments,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BodyFit,
  type SourceBody,
  SourceOverlay,
  type SourceSites,
  changeOfAxes,
  fromWxyz,
  meshWorldPose,
} from './sourceOverlay.js';

// The parser is not what is under test; a geometry that remembers which file it came from is.
vi.mock('three/examples/jsm/loaders/STLLoader.js', () => ({
  STLLoader: class {
    parse(data: ArrayBuffer): BufferGeometry {
      const geometry = new BufferGeometry();
      geometry.userData.file = new TextDecoder().decode(data);
      return geometry;
    }
  },
}));

interface Held {
  readonly url: string;
  resolve(response: Response): void;
}

let held: Held[] = [];
const fetchMock = vi.fn((url: string) => {
  return new Promise<Response>((resolve) => {
    held.push({ url, resolve });
  });
});

/**
 * Wait until a fetch of this url is held. A load imports its STL loader before it fetches, and on
 * a busy machine that import can outlast any fixed number of event-loop turns, so the tests wait
 * for the fetch itself rather than counting turns.
 */
async function pending(url: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!held.some((h) => h.url === url)) throw new Error(`nothing is waiting on ${url}`);
    },
    { timeout: 5000, interval: 5 },
  );
}

/** Wait for a fetch of this url to be held, and take it off the list. */
async function take(url: string): Promise<Held> {
  await pending(url);
  const i = held.findIndex((h) => h.url === url);
  return held.splice(i, 1)[0] as Held;
}

/** Let every held fetch for these files go, each answering with its own name as the body. */
async function answer(files: readonly string[], type = 'model/stl'): Promise<void> {
  for (const file of files) {
    const h = await take(`refMeshes/${file}`);
    h.resolve(new Response(file, { status: 200, headers: { 'content-type': type } }));
  }
}

/** Enough turns of the event loop for every chain of awaits in a load to run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

const I = [1, 0, 0, 0];

function body(name: string, files: readonly string[], pos = [0, 0, 0]): SourceBody {
  return {
    name,
    parent: null,
    meshes: files.map((file) => ({ file, pos: [0, 0, 0], quat: I })),
    pos,
    quat: I,
  };
}

const PATH = [0, 0, 0, 1, 0, 0, 1, 1, 0];

const SITES: SourceSites = {
  format: 'bs-humany.source-sites/1',
  models: {
    A: {
      muscles: [
        { name: 'a', path: PATH, on: ['a1', 'a1', 'a2'], bodies: ['a1', 'a2'] },
        { name: 'b', path: [0, 0, 0, 0, 1, 0], on: ['a1', 'a1'], bodies: ['a1'] },
        { name: 'c', path: [0, 0, 0, 0, 0, 1], on: ['a2', 'a2'], bodies: ['a2'] },
      ],
      joints: [],
      bodies: [body('a1', ['a1.stl']), body('a2', ['a2.stl'], [0, 0, 1])],
    },
    B: {
      muscles: [],
      joints: [],
      bodies: [body('b1', ['b1.stl', 'b2.stl']), body('b2', ['b3.stl'])],
    },
  },
};

function meshes(overlay: SourceOverlay): Mesh[] {
  return overlay.bones.children.filter((c): c is Mesh => c instanceof Mesh);
}

function line(overlay: SourceOverlay, name: string): LineSegments {
  const found = overlay.group.children.find((c) => c.name === name);
  if (!(found instanceof LineSegments)) throw new Error(`no line ${name}`);
  return found;
}

beforeEach(() => {
  held = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pose helpers', () => {
  it('reads MuJoCo quaternions w first', () => {
    const identity = fromWxyz([1, 0, 0, 0]);
    expect(identity.angleTo(new Quaternion())).toBeCloseTo(0, 9);
    // w = 0 and all of it on z: a half turn about Z, which sends +X to -X.
    const half = fromWxyz([0, 0, 0, 1]);
    const x = new Vector3(1, 0, 0).applyQuaternion(half);
    expect(x.x).toBeCloseTo(-1, 9);
    expect(x.y).toBeCloseTo(0, 9);
  });

  it('puts a geom offset through its body pose', () => {
    const s = Math.SQRT1_2;
    const quarterZ: SourceBody = {
      name: 'b',
      parent: null,
      meshes: [],
      pos: [1, 0, 0],
      quat: [s, 0, 0, s],
    };
    const { position } = meshWorldPose(quarterZ, { file: 'x', pos: [0.1, 0, 0], quat: I });
    expect(position.x).toBeCloseTo(1, 9);
    expect(position.y).toBeCloseTo(0.1, 9);
    expect(position.z).toBeCloseTo(0, 9);
  });
});

describe('change of axes', () => {
  it('stands the arm up with a quarter turn about Y and the others as before', () => {
    expect(changeOfAxes('arm')).toMatchObject({ rx: 0, ry: 90, rz: 0 });
    expect(changeOfAxes('legs')).toMatchObject({ rx: -90, ry: 0, rz: 180 });
    expect(changeOfAxes('torso')).toEqual(changeOfAxes('legs'));
    expect(changeOfAxes('unheard-of')).toEqual(changeOfAxes('legs'));
  });

  it('carries the arm (x, y, z) to (z, y, -x): anterior forward, lateral to our right', () => {
    const p = changeOfAxes('arm');
    const turn = new Euler((p.rx * Math.PI) / 180, (p.ry * Math.PI) / 180, (p.rz * Math.PI) / 180);
    const at = (v: [number, number, number]) =>
      new Vector3(...v)
        .applyEuler(turn)
        .toArray()
        .map((c) => Math.round(c * 1e9) / 1e9 + 0);
    expect(at([1, 0, 0])).toEqual([0, 0, -1]);
    expect(at([0, 1, 0])).toEqual([0, 1, 0]);
    expect(at([0, 0, 1])).toEqual([1, 0, 0]);
  });
});

describe('paths', () => {
  it('draws a path the same whether it is theirs or retargeted', () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    overlay.show('A');
    const theirs = line(overlay, 'a');
    const positions = Array.from(theirs.geometry.getAttribute('position').array);
    const m1 = theirs.material as LineBasicMaterial;
    const before = [m1.color.getHex(), m1.opacity, m1.transparent, m1.depthTest];
    overlay.showRetargeted(new Map([['a', PATH]]));
    const ours = line(overlay, 'a');
    const m2 = ours.material as LineBasicMaterial;
    expect(Array.from(ours.geometry.getAttribute('position').array)).toEqual(positions);
    expect([m2.color.getHex(), m2.opacity, m2.transparent, m2.depthTest]).toEqual(before);
  });

  it('keeps paired grey and the picked muscle lit across a redraw', () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    overlay.show('A');
    overlay.markPaired(new Set(['a']));
    overlay.emphasise('b');
    const paths = new Map(SITES.models.A?.muscles.map((m) => [m.name, m.path]));
    overlay.showRetargeted(paths);
    expect((line(overlay, 'a').material as LineBasicMaterial).color.getHex()).toBe(0x6d747f);
    expect((line(overlay, 'b').material as LineBasicMaterial).opacity).toBe(0.95);
    expect((line(overlay, 'c').material as LineBasicMaterial).opacity).toBe(0.08);
  });
});

describe('bone meshes', () => {
  it('shows only the last model picked when the first is still arriving', async () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    const first = overlay.showBones('A');
    await pending('refMeshes/a1.stl');
    await pending('refMeshes/a2.stl');
    const second = overlay.showBones('B');
    await settle();
    await answer(['a1.stl', 'a2.stl']);
    await answer(['b1.stl', 'b2.stl', 'b3.stl']);
    await Promise.all([first, second]);
    await settle();
    expect(meshes(overlay).map((m) => m.geometry.userData.file)).toEqual([
      'b1.stl',
      'b2.stl',
      'b3.stl',
    ]);
    expect(await second).toEqual({ total: 3, loaded: 3 });
    expect(overlay.meshCount()).toEqual({ total: 3, loaded: 3 });
  });

  it('does not double up when the same model is shown twice', async () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    void overlay.showBones('A');
    await pending('refMeshes/a1.stl');
    await pending('refMeshes/a2.stl');
    const again = overlay.showBones('A');
    await settle();
    await answer(['a1.stl', 'a2.stl']);
    await again;
    await settle();
    expect(meshes(overlay)).toHaveLength(2);
  });

  it('keeps declaration order whatever order the files arrive in', async () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    const loading = overlay.showBones('B');
    await settle();
    await answer(['b3.stl']);
    await settle();
    await answer(['b1.stl']);
    await settle();
    await answer(['b2.stl']);
    await loading;
    // The list is private; what is pinned is the promise its comment makes.
    const list = (overlay as unknown as { meshes: Mesh[] }).meshes;
    expect(list.map((m) => m.geometry.userData.file)).toEqual(['b1.stl', 'b2.stl', 'b3.stl']);
  });

  it('puts meshes that arrive after a retarget through its fit', async () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    const loading = overlay.showBones('A');
    await pending('refMeshes/a1.stl');
    const fits = new Map<string, BodyFit>([
      ['a1', { position: new Vector3(0, 1, 0), rotation: new Quaternion(), scale: 2 }],
    ]);
    overlay.retargetBones(fits, SITES.models.A?.bodies ?? []);
    await answer(['a1.stl', 'a2.stl']);
    await loading;
    const [a1, a2] = meshes(overlay).sort((p, q) => p.name.localeCompare(q.name));
    expect(a1?.visible).toBe(true);
    expect(a1?.position.toArray()).toEqual([0, 1, 0]);
    expect(a1?.scale.x).toBe(2);
    // Its body has no fit, so it is hidden rather than left at their pose.
    expect(a2?.visible).toBe(false);
  });

  it('adds nothing once disposed mid-load', async () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    const loading = overlay.showBones('A');
    await pending('refMeshes/a1.stl');
    overlay.dispose();
    await answer(['a1.stl', 'a2.stl']);
    await loading;
    await settle();
    expect(meshes(overlay)).toHaveLength(0);
  });

  it('counts a page served in place of a mesh as missing', async () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    const loading = overlay.showBones('B');
    await settle();
    await answer(['b1.stl', 'b3.stl']);
    await answer(['b2.stl'], 'text/html; charset=utf-8');
    expect(await loading).toEqual({ total: 3, loaded: 2 });
    expect(meshes(overlay)).toHaveLength(2);
  });

  it('counts a failed response as missing and asks again next time', async () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    const loading = overlay.showBones('A');
    await settle();
    await answer(['a1.stl']);
    (await take('refMeshes/a2.stl')).resolve(new Response('', { status: 404 }));
    expect(await loading).toEqual({ total: 2, loaded: 1 });
    fetchMock.mockClear();
    void overlay.showBones('A');
    await take('refMeshes/a2.stl');
    await settle();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['refMeshes/a2.stl']);
  });

  it('fetches a model it has shown before from its cache', async () => {
    const overlay = new SourceOverlay();
    overlay.load(SITES);
    const first = overlay.showBones('A');
    await settle();
    await answer(['a1.stl', 'a2.stl']);
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await overlay.showBones('A')).toEqual({ total: 2, loaded: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meshes(overlay)).toHaveLength(2);
  });
});
