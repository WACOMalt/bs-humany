"""
Decimated level of detail of the packed skeleton -- milestone M5.8.

Reads manifest.json + skeleton.bin, reduces every bone's triangle count by quadric edge
collapse, and writes skeleton-<lod>.bin + manifest-<lod>.json in the same format. Bone centroids
and bounds are copied from the full pack, so placement and every measurement derived from the
pack are unchanged; only the render triangles are fewer. Driven by
`pnpm --filter @bs-humany/ingest lods`.

    python decimate.py <dataDir> <lodName> <keepFraction>
"""

import json
import os
import sys

import numpy as np
import trimesh


def main():
    data_dir, lod, keep = sys.argv[1], sys.argv[2], float(sys.argv[3])
    manifest = json.load(open(os.path.join(data_dir, 'manifest.json')))
    raw = open(os.path.join(data_dir, 'skeleton.bin'), 'rb').read()
    nv = manifest['totals']['vertices']
    nt = manifest['totals']['triangles']
    positions = np.frombuffer(raw, dtype=np.float32, count=nv * 3).reshape(-1, 3)
    indices = np.frombuffer(raw, dtype=np.uint32, offset=nv * 12, count=nt * 3).reshape(-1, 3)

    out_positions, out_indices, bones = [], [], []
    vo = io = 0
    for b in manifest['bones']:
        v = positions[b['vertexOffset']:b['vertexOffset'] + b['vertexCount']].astype(np.float64)
        f = indices[b['indexOffset'] // 3:(b['indexOffset'] + b['indexCount']) // 3].astype(np.int64)
        mesh = trimesh.Trimesh(v, f, process=False)
        target = max(int(len(f) * keep), 12)
        if len(f) > target:
            mesh = mesh.simplify_quadric_decimation(face_count=target)
        pv = np.asarray(mesh.vertices, dtype=np.float32)
        pf = np.asarray(mesh.faces, dtype=np.uint32)
        out_positions.append(pv)
        out_indices.append(pf.reshape(-1))
        bones.append({
            **b,
            'vertexOffset': vo,
            'vertexCount': len(pv),
            'indexOffset': io,
            'indexCount': pf.size,
        })
        vo += len(pv)
        io += pf.size

    pos = np.concatenate(out_positions)
    idx = np.concatenate(out_indices)
    blob = pos.tobytes() + idx.tobytes()
    open(os.path.join(data_dir, f'skeleton-{lod}.bin'), 'wb').write(blob)
    out = {
        **manifest,
        'bones': bones,
        'totals': {'vertices': int(len(pos)), 'triangles': int(len(idx) // 3), 'bytes': len(blob)},
        'lod': {'name': lod, 'keepFraction': keep, 'of': 'manifest.json'},
    }
    json.dump(out, open(os.path.join(data_dir, f'manifest-{lod}.json'), 'w'), indent=1)
    open(os.path.join(data_dir, f'manifest-{lod}.json'), 'a').write('\n')
    print(
        f'{lod}: {nt} -> {len(idx) // 3} triangles, {nv} -> {len(pos)} vertices, '
        f'{len(blob) / 1048576:.1f} MB',
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
