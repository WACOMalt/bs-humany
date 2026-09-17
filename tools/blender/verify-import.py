# Does an export, imported into a real Blender, put the muscles where the bones are?
#
#   blender --background --factory-startup --python tools/blender/verify-import.py -- <folder>
#
# The folder is one an "Export for Blender" wrote: a .glb, a .pc2 and the generated .py.
#
# ## Why this exists, and why the obvious check is not enough
#
# The first version of this checked that the Mesh Cache modifier reproduced the vertex cache. It
# did, exactly, at every frame -- and the bellies were still ninety degrees about X away from the
# skeleton, because the cache and the mesh were in different spaces and the check compared the
# cache against itself. glTF is +Y up, Blender is +Z up, and the importer resolves that by baking
# `(x, y, z) -> (x, -z, y)` into mesh data; a cache read by a modifier never goes through the
# importer and so never gets it.
#
# So what is checked here is agreement between things that came by *different routes*: the bellies
# arrive through a modifier reading a binary, the bones arrive through the glTF importer, and if
# those two disagree about which way is up it shows immediately. Specifically:
#
#   1. The first cache sample equals the imported rest mesh. Both describe frame zero, and they
#      reached Blender by the two different routes. This is the assertion that catches the axes.
#   2. The bellies sit inside the skeleton's own bounding box, with room to spare, at several
#      frames. A body standing up is roughly 1.7 m in Z and 0.4 m in Y; rotate it about X and
#      those swap, which no tolerance can hide.
#   3. The bellies move. A cache that quietly did nothing would otherwise pass the first two.
#
# Exits non-zero and says which of them failed.

import os
import struct
import sys

import bpy
from mathutils import Vector

FAILURES = []


def check(name, ok, detail="", note=""):
    """`detail` is worth reading either way; `note` explains a failure and is noise otherwise."""
    line = "  PASS  " if ok else "  FAIL  "
    print(line + name + (("  -- " + detail) if detail else "") + (("  -- " + note) if note and not ok else ""))
    if not ok:
        FAILURES.append(name)


def bounds(points):
    lo = [min(p[k] for p in points) for k in range(3)]
    hi = [max(p[k] for p in points) for k in range(3)]
    return lo, hi


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    folder = argv[0] if argv else os.getcwd()
    names = os.listdir(folder)
    script = os.path.join(folder, next(f for f in names if f.endswith(".py")))
    cache = os.path.join(folder, next(f for f in names if f.endswith(".pc2")))

    print("verifying", folder)
    exec(compile(open(script).read(), script, "exec"), {"__file__": script})

    belly = bpy.data.objects.get("muscles")
    check("the export carries a joined belly mesh", belly is not None)
    if belly is None:
        return
    check(
        "it has a mesh cache modifier",
        any(m.type == "MESH_CACHE" for m in belly.modifiers),
    )

    with open(cache, "rb") as f:
        _, _, points, _, _, samples = struct.unpack("<12siiffi", f.read(32))

        def sample(index, count):
            f.seek(32 + index * points * 12)
            return struct.unpack("<%df" % (count * 3), f.read(count * 3 * 4))

        check(
            "the cache has one point per vertex of that mesh",
            points == len(belly.data.vertices),
            "%d points against %d vertices" % (points, len(belly.data.vertices)),
        )

        # 1. The two routes agree about frame zero. This is the axis check.
        head = sample(0, min(points, 4096))
        worst = 0.0
        for v in range(min(points, 4096)):
            for k in range(3):
                worst = max(worst, abs(belly.data.vertices[v].co[k] - head[v * 3 + k]))
        check(
            "the cache and the imported rest mesh are in the same space",
            worst < 1e-4,
            "worst vertex differs by %.5f m" % worst,
            "an axis conversion is missing on one side of the export",
        )

        # 2. The bellies are inside the skeleton, at several frames.
        # Bones only. The ground plane is ten metres across and the scenario furniture is
        # wherever it was put, and either of them in this bounding box would make it loose enough
        # to accept a body lying on its face as a body standing up.
        scenery = {"ground", "scene"}
        bones = [
            o
            for o in bpy.data.objects
            if o.type == "MESH"
            and o is not belly
            and o.name not in scenery
            and (o.parent.name if o.parent else "") not in scenery
        ]
        check("the skeleton came in too", len(bones) > 50, "%d bone meshes" % len(bones))
        corners = [
            tuple(o.matrix_world @ Vector(corner)) for o in bones for corner in o.bound_box
        ]
        skeleton_lo, skeleton_hi = bounds(corners)
        print(
            "  skeleton bounds  x %.2f..%.2f  y %.2f..%.2f  z %.2f..%.2f"
            % (skeleton_lo[0], skeleton_hi[0], skeleton_lo[1], skeleton_hi[1], skeleton_lo[2], skeleton_hi[2])
        )

        depsgraph = bpy.context.evaluated_depsgraph_get()
        moved = 0.0
        first = None
        for frame in (0, max(0, samples // 3), max(0, samples - 1)):
            bpy.context.scene.frame_set(frame)
            depsgraph.update()
            evaluated = belly.evaluated_get(depsgraph)
            mesh = evaluated.to_mesh()
            points_now = [tuple(v.co) for v in mesh.vertices]
            lo, hi = bounds(points_now)
            evaluated.to_mesh_clear()
            print(
                "  frame %4d bellies  x %.2f..%.2f  y %.2f..%.2f  z %.2f..%.2f"
                % (frame, lo[0], hi[0], lo[1], hi[1], lo[2], hi[2])
            )
            # A tenth of a metre of slack: flesh stands off bone, and a belly may reach past the
            # end of the bone it runs along. A wrong axis is off by a metre, not a tenth.
            inside = all(
                lo[k] > skeleton_lo[k] - 0.10 and hi[k] < skeleton_hi[k] + 0.10 for k in range(3)
            )
            check("the bellies sit within the skeleton at frame %d" % frame, inside)
            if first is None:
                first = points_now
            else:
                moved = max(
                    moved,
                    max(abs(a[k] - b[k]) for a, b in zip(first, points_now) for k in range(3)),
                )

        # 3. And they are actually driven.
        check("the bellies move over the run", moved > 1e-3, "%.4f m" % moved)

    print("")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        sys.exit(1)
    print("all checks passed")


main()
