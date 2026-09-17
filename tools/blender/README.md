# Checking an export in a real Blender

```bash
blender --background --factory-startup --python tools/blender/verify-import.py -- <folder>
```

The folder is one that "Export for Blender" wrote: a `.glb`, a `.pc2` vertex cache and the
generated `.py`. The script runs that import and then asks whether what arrived makes sense.
It exits non-zero and names what failed.

Not a CI gate, because it needs Blender. Run it when the export changes.

## What it checks, and the check it is named after

The muscles arrive by a different route from everything else -- through a Mesh Cache modifier
reading a binary, where the bones come through the glTF importer -- and the one failure that route
introduces is a disagreement about which way is up. glTF is +Y up, Blender is +Z up, and the
importer resolves that by baking `(x, y, z) -> (x, -z, y)` into mesh data on the way in. A cache
read by a modifier never goes through the importer, so it has to arrive already converted.

It did not, for one commit, and the bellies sat ninety degrees about X from the skeleton. What
made that possible is that the check in place at the time compared the modifier's output against
the cache it had just read: the same numbers by the same route, agreeing perfectly, about a body
lying at right angles to its own bones.

So the assertions here are all between things that came by *different* routes:

1. **The first cache sample equals the imported rest mesh.** Both describe frame zero; one came
   through the importer and one did not. This is the assertion that catches the axes, and on the
   broken export it reports 1.65 m.
2. **The bellies sit inside the skeleton's own bounding box** at several frames -- the ground
   plane and the scenario furniture excluded, or the box is ten metres across and would accept
   anything.
3. **The bellies move.** A cache that quietly did nothing would pass the first two.
