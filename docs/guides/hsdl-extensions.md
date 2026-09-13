# HSDL extension namespaces

Spec section 14.5, item 3: modules annotate the model without forking the schema.

Every HSDL element that can carry data for a module has an `ext` field: bones, joints and their
DoFs, landmarks, attachment sites, collision proxies, segments, segmentation profiles, contact
rules, constraints and the document itself. `ext` is a map from a **reverse-DNS namespace** to
any JSON value. The schema validates the key's shape and nothing about the value, which is the
point: the core does not know what a future nerve module wants to record, and must not have to.

```ts
import { moduleNamespace, readExtension, writeExtension } from '@bs-humany/hsdl';

const NS = moduleNamespace('nerve'); // 'bsums.xyz.bs-humany.nerve'

bone.ext = writeExtension(bone.ext, NS, { afferents: ['ia', 'ib'] });
const data = readExtension(bone.ext, NS, MyZodSchema); // undefined when absent, throws when malformed
```

## Rules

1. **Keys are namespaces.** `bsums.xyz.bs-humany.<module>` for first-party modules
   (`moduleNamespace(name)` builds them); your own reverse-DNS prefix for anything else. An
   unqualified key such as `nerve` is rejected by the validator, because two modules would
   collide on it.
2. **Values are yours.** The core never reads another module's namespace. Give your value a Zod
   schema and read it back through `readExtension` so a malformed value fails where it is read,
   not three modules later.
3. **Extensions survive everything.** Validation, JSON round-trips and the compiler carry unknown
   namespaces through untouched (`extensions.test.ts` proves the round trip). The compiler does
   not copy them into the `CompiledArticulation`; a module that needs its data at step rate reads
   the document at init and builds its own index-addressed arrays, as the mechanical modules do.
4. **Absent is not malformed.** `readExtension` returns `undefined` when the namespace is not
   present and throws when it is present but fails your schema.

## First-party namespaces in use

| Namespace | On | Carries |
|---|---|---|
| `…provenance` | landmarks, attachment sites | dataset name, version, hash, and how the point was located |
| `…joint` | joints | how the centre was located, which frame oriented it, whether the side was mirrored |
| `…proxy` | collision proxies, contact rules | the bounds a proxy was fitted to, the overlap behind each exclusion |
| `…frame` | (reserved) | frame construction notes |

The full prefix is `bsums.xyz.bs-humany`.
