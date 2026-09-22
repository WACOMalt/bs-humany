# Bridging the two datasets: a work plan

**Why.** The bones, landmarks and attachments are measured from Z-Anatomy. The four
musculotendon scalars come from MyoSuite, fitted to a body we do not have and cannot ship.
Two of those four are lengths on the source's bones, so they are refitted here — and both
refits need to know how far a muscle travels on each skeleton. `tools/train/runs/datasetgap.mjs`
measures that gap. What it found, on `l3_anatomical`:

| region | units | compared | median ratio |
|---|---|---|---|
| ankle & foot | 18 | 18 | 1.71 |
| forearm | 16 | 16 | 0.34 |
| elbow | 14 | 14 | 0.80 |
| hip, knee, shoulder | 80 | 76 | 0.97–1.07 |
| thorax, neck, girdle, trunk, torso | 106 | **0** | — |

The median muscle agrees within one per cent. The disagreement is concentrated, not spread,
and it sits in three places with three different causes.

## What is actually wrong, and what fixes each

1. **106 units never measured against anything.** `myotorso_tendon.xml` *is* vendored — 210
   muscles, 588 sites. It was never measured because the names do not match (0 of 53) and the
   correspondence is not one to one: six `EO1..EO6` strips against our one `external_oblique`.
   Fixed by a **correspondence mapping**, which is human judgement, not a script.
2. **The toe muscles.** `flexor_digitorum_longus` travels 47 mm here against 13 there and
   crosses one joint: `talocrural/dorsiflexion`. It is a toe flexor with no toe joint. All five
   toes are one welded segment. Fixed by **articulating the foot**, not by moving points.
3. **Points wrong on our own terms.** `l5_s1` sits 17 mm off the midline and `c0_c1` 23 mm,
   both taking a marker — a label anchor — as a joint centre. Hip and shoulder were already
   fixed for this. Fixed by **measuring from our own mesh**, with a manipulator to do it by eye.

Attachment points stay ours (ADR-011). The source is a cross-check and never a snap target.

## The work, in the order it will be done

### 1 — The alignment tool  *(one deliverable, three panes)*
- [x] 1.1 Parse the vendored MJCF into muscle -> path sites -> world positions, for torso, arm and legs
- [x] 1.2 Their sites drawn in the viewport as a reference overlay, plainly marked as the other
      body, never a snap target
- [x] 1.3 Correspondence picker: their muscles beside ours, click to pair, many-to-one allowed,
      with automatic suggestions where a name or a path plainly matches
- [x] 1.4 Point inspector: our joint centres and attachment sites as pickable handles
- [x] 1.5 A transform gizmo, XYZ, snapping off by default
- [x] 1.6 Write both outputs with provenance: the correspondence mapping, and an override file
      recording each moved point, how far it moved, and a required note
- [ ] 1.7 Extend `measure:source-travel` to use the mapping and measure the 106 unmeasured units

### 2 — The spinal discs
Two separate faults, and the first is documented rather than accidental.
- [ ] 2.1 **Too far back, all of them.** A spine joint centre is `centroidMid` -- midway between
      two vertebral centroids -- which `jointHelpers.ts` already records as sitting "a little
      posterior to the disc", because a centroid includes the posterior arch. The disc is drawn at
      the joint frame and inherits it. Decide whether the joint centre moves (changes the
      articulation) or the drawn disc is offset from it (changes only the picture).
- [ ] 2.2 **Top and bottom offset sideways.** `l5_s1` sits 17 mm off the midline and `c0_c1`
      23 mm, both taking a single marker as a joint centre. Markers are label anchors; hip and
      shoulder were already fixed for exactly this. Every other spinal disc is at 0.0000.

### 3 — Separate the toes at L3
- [x] 3.1 Five digital rays as their own segments, rather than one welded `toes_*`
- [x] 3.2 Colliders generated per ray rather than one hull over the group
- [x] 3.3 Re-map every connection that was attached to the grouped joint, to the ray it belongs to
- [x] 3.4 Confirm against the gap measurement: the four worst muscles are all toe muscles

### 4 — The hand, and muscles for both ends
- [ ] 4.1 Articulate the hand: 31 segments exist and carry no joints at all
- [ ] 4.2 Toe and finger muscles, with drive groups of their own
- [ ] 4.3 Carry them through every render path, the trainer, and both panels
