"""
Convex decomposition of bone groups with CoACD -- milestone M5.8.

Reads the packed skeleton (manifest.json + skeleton.bin) and a groups file written by
src/hulls.ts, runs CoACD on the merged mesh of each group, reduces every piece to a small
vertex budget, and writes the hull vertex lists back as JSON in world metres at the dataset
stature. Driven by `pnpm --filter @bs-humany/ingest hulls`; not meant to be run by hand.

    python decompose.py <dataDir> <groups.json> <out.json>

Every group runs in its own fresh interpreter. A group the groups file gives a `tier` for (the
one the committed hulls.json records) runs at that tier only, with no time limit: CoACD is seeded,
so the same tier on the same mesh gives the same pieces, and a limit could only make the result
depend on how busy the machine is. A group with no recorded tier -- new, or re-budgeted -- runs
under a time limit, and if it overruns is retried with cheaper settings, then with one plain hull
per bone, so the batch always finishes. The tier that produced each group is recorded next to its
hulls, which is what the next run replays.

The installed versions of the packages that shape the result are written into the output too:
the pieces are reproducible for the versions requirements.txt pins, not across them.

Offline only, by design (spec section 8.1): hulls are never generated at runtime.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib.metadata import version

import numpy as np
import trimesh

MAX_VERTICES = 48
SEED = 0
TIME_LIMIT_SECONDS = 120
WORKERS = 8

# Tried in order by a group with no recorded tier; it moves to the next tier when the previous
# one overruns the limit.
SETTINGS = [
    {
        'name': 'standard',
        'threshold': 0.05,
        'resolution': 1000,
        'preprocess_resolution': 100,
        'mcts_nodes': 10,
        'mcts_iterations': 60,
        'mcts_max_depth': 2,
    },
    {
        'name': 'coarse',
        'threshold': 0.1,
        'resolution': 500,
        'preprocess_resolution': 50,
        'mcts_nodes': 5,
        'mcts_iterations': 20,
        'mcts_max_depth': 1,
    },
    {'name': 'hull-per-bone'},
]
TIER_NAMES = [s['name'] for s in SETTINGS]

# Everything that shapes the pieces: CoACD cuts them, trimesh and SciPy (under trimesh) take their
# hulls, NumPy does the arithmetic. Read from the installed distributions, because coacd has no
# __version__ and the table used to record 'unknown'.
VERSIONED = ['coacd', 'trimesh', 'numpy', 'scipy']


def load_pack(data_dir):
    manifest = json.load(open(os.path.join(data_dir, 'manifest.json')))
    raw = open(os.path.join(data_dir, 'skeleton.bin'), 'rb').read()
    nv = manifest['totals']['vertices']
    nt = manifest['totals']['triangles']
    positions = np.frombuffer(raw, dtype=np.float32, count=nv * 3).reshape(-1, 3)
    indices = np.frombuffer(raw, dtype=np.uint32, offset=nv * 12, count=nt * 3).reshape(-1, 3)
    bones = {b['id']: b for b in manifest['bones']}
    return positions, indices, bones


def bone_mesh(positions, indices, bones, name):
    b = bones[name]
    v = positions[b['vertexOffset']:b['vertexOffset'] + b['vertexCount']].astype(np.float64)
    f = indices[b['indexOffset'] // 3:(b['indexOffset'] + b['indexCount']) // 3].astype(np.int64)
    return v, f


def group_mesh(positions, indices, bones, names):
    vs, fs, offset = [], [], 0
    for name in names:
        v, f = bone_mesh(positions, indices, bones, name)
        vs.append(v)
        fs.append(f + offset)
        offset += len(v)
    return np.concatenate(vs), np.concatenate(fs)


def farthest_points(points, count):
    """A deterministic spread of `count` points: each pick is the farthest from those chosen."""
    chosen = [int(np.argmax(np.linalg.norm(points - points.mean(axis=0), axis=1)))]
    distance = np.linalg.norm(points - points[chosen[0]], axis=1)
    while len(chosen) < count:
        nxt = int(np.argmax(distance))
        chosen.append(nxt)
        distance = np.minimum(distance, np.linalg.norm(points - points[nxt], axis=1))
    return points[chosen]


def reduce_hull(vertices, faces):
    """
    Convex hull of a piece with at most MAX_VERTICES vertices.

    Over budget, a well-spread subset of the hull's own vertices is kept and its hull taken:
    that is inscribed in the true hull, so the proxy can only shave corners, never grow.
    (Quadric decimation, the obvious alternative, places vertices outside the hull and inflated
    a rib cage by more than a centimetre.)
    """
    hull = trimesh.Trimesh(vertices, faces, process=False).convex_hull
    if len(hull.vertices) > MAX_VERTICES:
        hull = trimesh.PointCloud(farthest_points(np.asarray(hull.vertices), MAX_VERTICES)).convex_hull
    return hull.vertices.tolist()


def decompose_one(data_dir, names, max_hulls, tier):
    """One group, one settings tier. Runs in a fresh interpreter (see `main`)."""
    positions, indices, bones = load_pack(data_dir)
    settings = SETTINGS[tier]
    if settings['name'] == 'hull-per-bone':
        return [reduce_hull(*bone_mesh(positions, indices, bones, n)) for n in names]
    import coacd

    coacd.set_log_level('error')
    v, f = group_mesh(positions, indices, bones, names)
    parts = coacd.run_coacd(
        coacd.Mesh(v, f),
        threshold=settings['threshold'],
        max_convex_hull=max_hulls,
        preprocess_mode='auto',
        preprocess_resolution=settings['preprocess_resolution'],
        resolution=settings['resolution'],
        mcts_nodes=settings['mcts_nodes'],
        mcts_iterations=settings['mcts_iterations'],
        mcts_max_depth=settings['mcts_max_depth'],
        merge=True,
        seed=SEED,
    )
    return [reduce_hull(np.asarray(p[0]), np.asarray(p[1])) for p in parts]


def run_group(data_dir, key, names, max_hulls, recorded):
    """
    Decompose one group in a subprocess; return (hulls, tier, seconds).

    With a recorded tier, run that tier alone and with no time limit, and fail rather than fall
    back: a fallback would quietly write a different decomposition than the one being replayed.
    Without one, climb the tiers, each but the last under the time limit.
    """
    started = time.time()
    tiers = [TIER_NAMES.index(recorded)] if recorded is not None else range(len(SETTINGS))
    for tier in tiers:
        timed = recorded is None and tier < len(SETTINGS) - 1
        with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as tmp:
            out_path = tmp.name
        args = [
            sys.executable,
            os.path.abspath(__file__),
            '--one',
            data_dir,
            json.dumps(names),
            str(max_hulls),
            str(tier),
            out_path,
        ]
        env = {**os.environ, 'OMP_NUM_THREADS': '2'}
        try:
            run = subprocess.run(
                args,
                timeout=TIME_LIMIT_SECONDS if timed else None,
                env=env,
                capture_output=True,
                text=True,
            )
        except subprocess.TimeoutExpired:
            print(f'  {key[:60]}: {SETTINGS[tier]["name"]} overran {TIME_LIMIT_SECONDS} s, '
                  f'trying {SETTINGS[tier + 1]["name"]}', file=sys.stderr, flush=True)
            continue
        if run.returncode != 0:
            print(f'  {key[:60]}: {SETTINGS[tier]["name"]} failed: {run.stderr.strip()[-300:]}',
                  file=sys.stderr, flush=True)
            continue
        hulls = json.load(open(out_path))
        os.unlink(out_path)
        return hulls, tier, time.time() - started
    if recorded is not None:
        raise RuntimeError(f'the recorded tier {recorded} failed for {key}')
    raise RuntimeError(f'every settings tier failed for {key}')


def main():
    if sys.argv[1] == '--one':
        data_dir, names, max_hulls, tier, out_path = sys.argv[2:7]
        hulls = decompose_one(data_dir, json.loads(names), int(max_hulls), int(tier))
        json.dump(hulls, open(out_path, 'w'))
        return

    data_dir, groups_path, out_path = sys.argv[1:4]
    groups = json.load(open(groups_path))
    for k, g in groups.items():
        if g.get('tier') is not None and g['tier'] not in TIER_NAMES:
            raise ValueError(f'{k}: recorded tier {g["tier"]!r} is not one of {TIER_NAMES}')
    parameters = {
        'settings': SETTINGS,
        'timeLimitSeconds': TIME_LIMIT_SECONDS,
        'maxVertices': MAX_VERTICES,
        'seed': SEED,
        'preprocessMode': 'auto',
    }
    versions = {name: version(name) for name in VERSIONED}
    # Resume: a previous run's partial output is kept for a group when the parameters, the
    # package versions, the budget and -- if one is recorded -- the tier all match. src/hulls.ts
    # already keys the whole cache on the pack; these are what can change under the same pack.
    out = {}
    if os.path.exists(out_path):
        previous = json.load(open(out_path))
        if previous.get('parameters') == parameters and previous.get('versions') == versions:
            out = {
                k: v
                for k, v in previous['groups'].items()
                if k in groups
                and v.get('maxHulls') == groups[k]['maxHulls']
                and groups[k].get('tier') in (None, v.get('settings'))
            }
    jobs = [(k, g['bones'], g['maxHulls'], g.get('tier')) for k, g in groups.items() if k not in out]
    # Largest groups first so the pool's tail is short.
    jobs.sort(key=lambda j: -len(j[1]))
    print(f'{len(out)} groups resumed, {len(jobs)} to decompose', file=sys.stderr, flush=True)

    def save():
        json.dump(
            {
                'coacd': versions['coacd'],
                'versions': versions,
                'parameters': parameters,
                'groups': out,
            },
            open(out_path, 'w'),
        )

    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(run_group, data_dir, k, names, m, t): (k, names, m) for k, names, m, t in jobs
        }
        for future in as_completed(futures):
            key, names, max_hulls = futures[future]
            hulls, tier, seconds = future.result()
            done += 1
            out[key] = {'hulls': hulls, 'settings': SETTINGS[tier]['name'], 'maxHulls': max_hulls}
            save()
            print(
                f'[{done}/{len(jobs)}] {key[:60]}: {len(names)} bones -> {len(hulls)} hulls '
                f'({", ".join(str(len(h)) for h in hulls)}) [{SETTINGS[tier]["name"]}] in {seconds:.1f} s',
                file=sys.stderr,
                flush=True,
            )
    save()


if __name__ == '__main__':
    main()
