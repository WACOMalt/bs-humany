# Open source questions

Parameters that could not be derived from a citable source. Recorded here rather than invented or
copied from a reference oracle, per ADR-009 and CONTRIBUTING rules 4 and 5.

Each entry names what is missing, what is being used provisionally, and what would close it.

## Format

```
### OQ-nnn — short title
**Needed for:** ticket or package
**Provisional value:** what is in the code right now, and why it is defensible
**Closes when:** the specific source or measurement that would resolve it
**Status:** open | closed (commit)
```

---

### OQ-001 — de Leva (1996) Table 4 not yet verified against the source document
**Needed for:** `@bs-humany/anthropometry`, `deleva.ts`
**Provisional value:** The full male and female tables are transcribed and pass every automated
consistency check available: segment masses sum to 1.000 of body mass for both sexes, the three
trunk sub-segments decompose the trunk entry to four decimal places, every centre of mass falls
inside its segment, every radius of gyration is positive and below unity, and every derived inertia
tensor satisfies the triangle inequality at every sex-blend value. Directional dimorphism checks
also pass, which rules out a wholesale swap of the two tables.

Those checks catch a transposed digit that breaks an invariant. They **cannot** catch a value that
is internally consistent and simply not what the paper says.

**Closes when:** a human reads de Leva (1996) Table 4 and checks the 99 transcribed values line by
line, recording the check in `docs/validation/`. Then set `DE_LEVA_PROVENANCE.status` to
`'verified'`.
**Status:** open

### OQ-002 — ANSUR II reference statistics not yet verified against the source document
**Needed for:** `@bs-humany/anthropometry`, `ansur.ts`
**Provisional value:** 50th-percentile stature and body mass, and their standard deviations, for
each sex. Consistency-checked against published BMI ranges for the ANSUR II sample and against the
requirement that percentile scaling be monotonic.
**Closes when:** a human checks the values against Gordon et al. (2014) summary statistics tables.
**Status:** open

### OQ-003 — Segment-length proportions are not sex-separated
**Needed for:** `@bs-humany/anthropometry`, `ansur.ts`
**Provisional value:** Drillis & Contini (1966) fractions of stature, applied identically to both
endpoint tables. ANSUR II measures stature, weight and several breadths directly and
sex-separately, but does not publish most segment lengths as such, so the proportions come from a
source that is not sex-separated.

This understates real dimorphism in limb proportion -- notably the crural and brachial indices, and
relative leg length. The `proportions` overrides in `Morphology` exist so a user can correct for it
explicitly, but the defaults are currently sex-neutral and the model should say so rather than
implying a dimorphism it does not have.

**Closes when:** sex-separated segment-length proportions are derived from a citable published
source, or from ANSUR II's own 3D scan data.
**Status:** open

### OQ-004 — Provenance of the auditory ossicle meshes
**Needed for:** `@bs-humany/assets-anatomical`, `tools/ingest/src/mapping.ts`
**Provisional value:** the six ossicles (`malleus`, `incus`, `stapes`, both sides) are mapped in the
ingestion tool but **excluded from the packed data** and drawn from the procedural fallback.
Z-Anatomy's attributions credit "Anatomy of the Inner Ear" (University of Dundee, CC-BY-NC-SA 4.0)
among its sources. The ossicles are middle-ear structures, adjacent to but not part of the inner
ear, and the export carries no per-structure provenance, so it cannot be determined from the data
whether they derive from that source. A non-commercial licence cannot be combined with CC BY-SA in
one distributed work (ADR-009), so the safe default is exclusion.
**Closes when:** the Z-Anatomy maintainers confirm the ossicle meshes derive from BodyParts3D (which
does model them, as FMA52751-3), or the meshes are replaced from BodyParts3D directly. Then remove
`excluded` from the three mapping entries and re-run ingestion.
**Status:** open

### OQ-005 — ISB frame definitions: sections verified, hand and spine still to do
**Needed for:** `packages/skeleton/src/frames.ts`
**Provisional value:** the pelvis, femur, tibia/fibula and calcaneus systems were transcribed from
the text of Wu et al. (2002) §3.3, §3.4, §4.3, §4.4, and the thorax, clavicle, scapula, humerus
(option 1), ulna and radius systems from Wu et al. (2005) §2.3.1–2.3.6 and §3.3.3–3.3.4, read
directly from the ISB-hosted PDFs on 2026-09-13. Those are verified. The hand and wrist systems
(2005 §4) and the vertebral system (2002 §5.2, which needs endplate centres and pedicle bases the
pack does not mark) are not yet implemented; those bones are world-aligned at their centroid.
Also: MM and LM are derived as the most inferior vertex of the tibia and fibula respectively
(ISB: "tip of the malleolus"), because the export's marker for the left lateral malleolus is a
surface patch whose centroid sat 2 cm above the tip and tilted the tibia frame by 22°. With the
tip rule the two sides mirror to within 1°, but the malleolar axis inclination on this subject
comes out at about 23° in the frontal plane, at the high end of published values (Inman reports
the axis roughly 8° from the transverse plane). Whether that is the subject, the mesh, or the rule
picking a point below the true tip has not been established.
**Closes when:** hand/wrist and vertebral frames are defined from cited landmarks, and the
malleolar inclination is checked against the mesh by eye or against a second dataset.
**Status:** open (partial)

### OQ-006 — Left-side frame handedness
**Needed for:** `packages/skeleton/src/frames.ts`
**Provisional value:** every frame is right-handed with Z toward the subject's right, X anterior
and Y superior at neutral, on both sides. ISB 2005 defines the clavicle and scapula Z as "pointing
to AC/AA" (lateral), which for a left segment gives the opposite direction and, with X forward and Y
up, a left-handed frame. Reversing the pair keeps the frames right-handed and identical in meaning
across sides, which is also OpenSim's convention. The spec (§7.1) requires rotation orders be
explicit; joint definitions in M3.1 must account for this when comparing left-side angles to
literature that follows the literal ISB wording.
**Closes when:** the project owner confirms the policy, or joint-angle comparison against
published left-side data shows a sign discrepancy that requires the literal convention.
**Status:** open

### OQ-007 — Per-level ranges for L5/S1 and T12/L1
**Needed for:** `packages/skeleton/src/joints.ts`, joints `l5_s1` and `t12_l1` (L2 profile)
**Provisional value:** the mean of the four per-level lumbar ranges the MyoSuite torso model
carries (L1/L2 through L4/L5), for each of flexion, lateral bending and axial rotation. The source
has no joint of its own at either level: its lumped pelvis-to-thorax joint covers them, and the
per-level sum of lateral bending already exceeds that lumped value, so no remainder can be
assigned. The mean keeps the two levels in the same family as their neighbours without inventing a
gradient.
**Closes when:** a per-level source for L5/S1 and T12/L1 is cited (White & Panjabi's segmental
tables are the usual one; the licence question for transcribing them is open), or the torso model
gains those levels.
**Status:** open

### OQ-008 — Passive joint moment curves are not yet sourced per joint
**Needed for:** `packages/modules-mechanics/src/passiveJointModule.ts`
**Provisional value:** where a DoF carries no `passiveStiffness`, the module derives a
double-exponential end-range curve from the DoF's range and the child segment's inertia about the
axis: resistance rising over the last 0.2 rad before each limit, reaching a moment at the limit
that makes the effective wall stiffness a 6 Hz spring for that inertia, plus viscous damping
equal to the axis inertia times 4 per second. Defensible in form (Riener & Edrich 1999) and in
scale (tens of newton-metres at the hip, a few at the wrist), but the coefficients are chosen,
not measured, and the module and the UI say so.
**Closes when:** Riener & Edrich (1999) hip, knee and ankle coefficients are transcribed with
their knee-angle coupling, and an upper-limb and spinal source is found for the rest.
**Status:** open

### OQ-009 — Native range limits for oblique axes on the Rapier backend
**Needed for:** `packages/backend-rapier/src/rapierBackend.ts`, `packages/testkit/src/plausibility.ts`
**Provisional value:** two-DoF joints get an explicit Rapier frame with the first DoF on its Z,
so that DoF has a native limit; a second DoF gets one only when it lies on the frame's Y. The
subtalar inversion axis is oblique and is held by the emulated torsional stop alone, which yields
by up to about 0.4 rad when the whole body's weight bears on an ankle. The plausibility tolerance
for Rapier range violation is 0.45 rad for that reason.
**Closes when:** oblique-axis limits are expressed natively (chained revolute joints through a
light intermediate body, or a per-axis limit in a frame Rapier lets us choose freely), and the
tolerance can drop to what the axis-aligned DoFs already achieve.
**Status:** open

### OQ-010 — Per-level thoracic and cervical ranges
**Needed for:** `packages/skeleton/src/jointsL3.ts`, the L3-anatomical profile
**Provisional value:** thoracic levels take half of the lumbar per-level mean for flexion and
lateral bending and a fixed 0.2 rad of axial rotation; the cervical levels share the head
model's lumped neck range, with the atlanto-axial joint taking half of the axial rotation and the
atlanto-occipital joint a nod. The shapes follow every published segmental table; the numbers
are derived, not transcribed.
**Closes when:** a segmental cervical and thoracic source with a compatible licence is cited
(White & Panjabi's tables are the usual one), or the torso and head models grow the levels.
**Status:** open

### OQ-011 — Costovertebral, midtarsal and tarsometatarsal ranges
**Needed for:** `packages/skeleton/src/jointsL3.ts`
**Provisional value:** ribs get a pump-handle hinge of ±0.1 rad at the rib head; the midtarsal
and tarsometatarsal joints are rigid. The sternum is rigid with the first rib, so the rib cage
does not breathe.
**Closes when:** cited ranges exist for each, or a Phase 2 respiration module needs them.
**Also provisional here:** the costal cartilage. The first seven ribs are welded rigidly to the
sternum, because a tree of joints cannot close that loop and without it the seventh rib's tip
wanders 138 mm from the sternum over a three-second fall. Cartilage is compliant, so a rigid
weld overstates the stiffness; no cited value for the compliance is in hand.
**Status:** open

### OQ-012 — The neck ranges come from a commented-out joint
**Needed for:** `packages/skeleton/src/joints.ts`, the `neck_region_*` joints of every profile
**Provisional value:** flexion -0.87 to 1.05 rad and axial rotation ±1.4 rad, lumped for the
whole neck and halved between the two region joints. They are the numbers the reference's head
model states, but it states them in a commented-out block: that model was reduced to a rigid
chain when it was folded into the full-body assembly, and it now carries no live neck joint at
all. Found by the external validation of M5.7, which reads the vendored reference and reports a
citation whose element is absent.
**Closes when:** a live source states a cervical range -- a revision of the head model that
carries the joints, or a published table with a compatible licence -- and the ranges are cited
to it. Related to OQ-010, which covers the per-level cervical split.
**Status:** open

### OQ-013 — The Millard benchmark force profiles are figures, not tables
**Needed for:** `packages/muscle-model/src/benchmark.test.ts`, muscle spec 13.3
**Provisional value:** the N0.5 gate reproduces the benchmark protocol -- one muscle, constant
activation, sinusoidal length change -- and asserts every property of the result that can be
stated exactly: the closed-form isometric force at optimal fiber length, the published
rigid-tendon error band, the insensitivity to the damping coefficient that M-ADR-001 rests on,
first-order convergence of the integrator, and the plausibility rules of 13.4. What it does not
do is overlay the force trace on Millard's published curves, because those curves are figures and
the digitised traces are not in hand. Tracing numbers off a printed figure and asserting against
them would produce a test that measures the tracing rather than the model, which is the kind of
number CONTRIBUTING rule 3 exists to keep out.
**Closes when:** the benchmark's own trajectories and parameters are obtained in numeric form --
from the paper's supplementary material, from the OpenSim implementation the paper describes, or
by a direct comparison run against that implementation -- and the trace is compared point by
point with a stated tolerance.
**Status:** open

### OQ-014 — Elbow muscle pennation angles are zero, because the source model has none
**Needed for:** `packages/muscle-data/src/elbow.ts`
**Provisional value:** zero for all seven units. This is a faithful transcription rather than a
missing number: the MuJoCo muscle model has no pennation angle, so the conversion folded it into
the peak force and the force each actuator declares is already the force along the tendon. What
it costs is the *variation* of the pennation angle with fiber length, which the fiber model
computes from Zajac's constant-width assumption and which a zero angle removes entirely. For
these seven that loss is small -- the two biceps heads and brachioradialis are near-parallel
anyway -- and it is largest for the triceps heads, where published angles run to about 12
degrees, so their force along the tendon is overstated at short fiber lengths by up to a couple
of per cent.
**What the drawing needed from it, answered separately, 2026-09-16.** The mechanics still have no
pennation angle and this entry still blocks giving them one. But pennation has a second consequence
the render tier could not do without: a pennate muscle holds a large volume in a *long* belly,
because its short fibers lie at an angle between two long aponeuroses. Tier V was drawing the belly
as the flesh a Hill model reports, which is the fiber length, so every pennate muscle came out as a
short fat bead -- of fifty-four units on one side thirty-one were drawn at the full width the
aspect guard allowed, the median muscle was 0.60 as wide as it was long, and a gastrocnemius was
127 mm by 76 where a real one is about 250 by 60.

`bellySpread` measures, per muscle and once at rest, how much longer than its own flesh the belly
has to be drawn to have a muscle's proportions (`BELLY_ASPECT`, a quarter). It is a ratio rather
than a length, which is what keeps the bulge: pinning a pennate belly to a fixed length would have
looked right and then never moved again, because a fixed length holds a fixed volume at a fixed
radius.

The ratios land where architecture says they should, which is the evidence that they measure
something rather than fit a picture. Soleus comes out at 6.2 and is the most pennate muscle in the
body, with roughly 40 mm fibers in a 300 mm belly; gastrocnemius 3.2, the middle deltoid 3.1,
vastus lateralis 2.9; the long head of biceps 1.26 and semitendinosus 1.16, which are the two with
the longest fibers and the ones that need no spreading at all. Nothing was told which muscles are
pennate.

None of it reaches a force: Tier V writes only the render channel (M-ADR-004), and the full suite
passes with no golden moving.
**Closes when:** per-muscle pennation angles are transcribed from a source that states them
(Holzbaur 2005 does, for this region), and the peak forces are re-derived alongside them so the
two stay consistent. Taking the angles alone would double-count the pennation the forces already
include.
**Status:** open for the mechanics; the drawing no longer waits on it.

### OQ-015 — Muscle path geometry carried over from the reference model
**Needed for:** `packages/muscle-data/src/elbow.ts`, `packages/skeleton/src/muscleViaPoints.ts`
**Largely closed, 2026-09-15.** Two pieces of geometry were missing and both are now in: the
surface each muscle turns over at the elbow, and the points each one passes through along the way.

*The trochlea.* Measured from this subject's mesh at 18.0 mm radius about the epicondylar axis and
placed on the elbow's own axis, so it is coaxial with the joint by construction -- 0.000 mm of
offset, 0.0000 degrees of tilt. Before it, the triceps moment arm fell from -20 mm at full
extension to zero at about 2 rad and then reversed sign, so a fully driven triceps held a bent
elbow bent. It now holds flat at -18 to -20 mm across the range, which is what a pulley gives and
what published curves show. Its length is the span between the epicondyles rather than the measured
trochlear extent: the extent covers the groove a tendon bears in, and a cylinder cut to it is
shorter than the distance between the muscles that use the surface.

*The via points.* Carried over from the reference model by asking both models for the same
anatomical construction -- the glenohumeral centre, the bone's long axis, the elbow's flexion axis,
which is the humerus frame the ISB defines -- and taking the rotation between the two answers.
Nothing is transcribed: a coordinate lifted from one frame into another means nothing where it
lands. The two humeri differ by 4.4% in length and the points are scaled by that ratio.

What it bought, measured:

- **Biceps peaks at 39 mm**, against a published 36 to 40. It was 65 mm, and reversed sign at deep
  flexion because the last stretch of path ran from the humerus straight to the radial tuberosity
  and crossed the axis. Carrying the reference model's two points on the radius fixed both.
- **Every tendon now loads.** Three of the seven used to be shorter than their own resting length,
  so they made no force however hard they were driven. The longer paths take up.
- **The muscles lie along the bones** rather than cutting through them.

A wrapping surface was tried for the shaft first and is the wrong tool for a muscle running along
a bone; the measurements are below, and the shaft cylinder is kept because it is correct geometry
even though no muscle now uses it.

**What the N1.9 sweep measured, 2026-09-15.** Every claim above was made from one pose, and a
moment arm read at one pose says almost nothing. `pnpm validate:moment-arms` now sweeps the elbow
from 0 to 130 degrees and puts each curve beside the reference model's own, computed the same way;
`docs/validation/moment-arms.md` is the standing record and the numbers below come from it.

- **The biceps and the triceps agree.** Both heads of biceps peak at 39 and 36 mm where the
  reference peaks at 41 and 38, at the same angle; all three heads of triceps stay within 4 mm of
  the reference through the range. That is better than the single-pose figures suggested, and the
  difference was the forearm: these arms depend on forearm rotation as much as on flexion, so a
  sweep that does not hold it is not reproducible.
- **One ordering fault, found and fixed.** Brachioradialis had its wrap declared after every via
  point, which put the obstacle on the span running down the forearm rather than the one crossing
  the elbow. Its arm went negative at full extension as a result -- a hard failure under 13.2. The
  generator now reads the position of the surface in the reference path instead of assuming it
  comes last.

**Still open, and why:**

- **Brachialis never touches the surface it declares.** The next one to do, and the last
  disagreement at the elbow worth more than a few millimetres. It peaks at 41 mm against the
  reference's 24, a mean error of 11.8, and travels 61 mm where the reference's travels 36 -- the
  widest travel ratio in the set at 1.68. The cause is not the wrap: our insertion sits far enough
  from the flexion axis that the straight line from origin to insertion passes outside the
  trochlea cylinder at every angle, so the wrap has nothing to do.

  Both ends are suspect and neither is a marker problem any more, because the markers have since
  been put on their bones. The origin is `Anteromedial_surface_of_humerus`, which moved 47.7 mm in
  that projection -- the largest move in the arm -- and names a *surface*, which is a footprint
  rather than a point. The insertion is `Tuberosity_of_ulna`, and the neighbouring
  `Coronoid_process_of_ulna` sits closer to the axis; moving the insertion there was tried before
  the projection landed and made the arm change sign at deep flexion.

  What to try, in order, with the machinery that now exists: the origin as a footprint over the
  features Gray names for it (`footprint` in `attachments.ts`, which fixed the vasti), and the
  insertion measured over its own region rather than taken from one marker. Neither is the ridge
  trace that fixed brachioradialis -- this is a patch on a surface, not a line along a border --
  so it wants a third measurement of the same family.
- **Brachioradialis: was a quarter of the reference, now within 15 mm of it, and the cause was
  not what this said.** The wrap surface was blamed, and the reference's surface there turns out
  to be a 15 mm cylinder against our 12.4 mm trochlea -- close enough that it could never have
  been worth 70 mm of moment arm. It was the origin. The lateral supracondylar ridge runs the
  lower third of the humerus and the dataset marks it once, near its bottom, 32 mm above the
  elbow; brachioradialis arises from the upper two-thirds of it. `ridgeAttachments.ts` measures
  the ridge off the mesh -- the outermost vertex in each of 24 bins along the stretch of bone it
  occupies -- and takes the centroid of the part the muscle arises from, at 65 mm up. The peak arm
  went from 18 mm to 64, the mean error from 42.6 to 14.7, and its path from 284 mm to 333 against
  the reference's 331. What is left is the shape at the end of the range: ours peaks at 110
  degrees and falls to 27 mm by 130, where the reference is still climbing.

  It has a cost, and it is the source's arithmetic rather than this skeleton's. A moment arm is an
  excursion, so a muscle with the longest flexion arm at the elbow has the largest excursion: the
  path now shortens by 98 mm between a straight elbow and a bent one, on the 102 mm fiber MyoSuite
  gives it, and at full flexion the tendon goes slack because there is no fiber left to pull with.
  The source model does the same thing -- it runs that muscle between 0.14 and 1.42 of optimal
  over the same range -- and a real brachioradialis has fascicles half as long again. The fiber
  translation in OQ-020 cannot help, because it only lengthens a fiber when our path travels
  further than the source's and here it travels less.
- **Distal humerus and forearm wrap surfaces.** The same construction that carried the via points
  would carry these; the muscle that needs one is brachioradialis.
- **The proportional assumption.** Forearm points are scaled by the *humerus* ratio, because one
  frame carries the whole arm. Where the two skeletons' proportions differ, a forearm point is out
  by the difference between the two ratios -- a few per cent of a bone.

**What the shaft cylinder experiment showed**, kept because it is the reason via points were the
answer. A cylinder is a poor model of a humerus: narrow through the shaft, flared at both ends, so
one wide enough to catch a muscle near the ends stands clear of the bone in the middle. At 12.9 mm,
the median of the shaft surface, the long head of biceps switched three times between hugging the
bone and cutting through it across one sweep of the elbow -- the length stays continuous through
that, but the drawn path goes from fifteen points to two, which reads as the muscle flicking from
side to side. At 16.4 mm, sized to enclose the shaft, it is stable and the flexors clear it at
nearly every angle. Two fixes came out of it: an enclosing percentile is the right statistic for a
surface a muscle lies *outside* rather than bears on, and a shaft cylinder must span the shaft
rather than the whole bone -- run the length of the humerus, its top reaches the glenoid, where the
long head of biceps originates 13.6 mm from the axis, inside the surface, where the wrap geometry
has no answer and silently gave none.
**Status:** open

### OQ-020 — Muscle parameters state the source model's path lengths, not ours
**Needed for:** `packages/muscle-data/src/elbow.ts`, `packages/muscle-data/src/shoulder.ts`
**Provisional value:** MyoSuite's scalars as they stand. Optimal fiber length and tendon slack
length are derived from the source model's own operating range and length range, and a length
range is a statement about *its* skeleton: how long that muscle's path is, on those bones, at
those attachments. Ours are our own -- Gray's anatomy on this subject's markers -- so the two
disagree, and the muscle sits somewhere else on its curves than the source intended.

Measured, at a neutral pose, ours against the reference model's own path lengths computed the
same way:

    deltoid anterior   223 mm   209      supraspinatus     120 mm   120
    deltoid middle     197      210      infraspinatus     127      102
    deltoid posterior  189      154      subscapularis     146      110
    triceps lateral    213      167      teres minor       181      126
    biceps long        485      429      teres major       231      156

The deltoid and supraspinatus agree; the rotator cuff and teres major are 25 to 75 mm long, which
is a third of their own length. A path longer than its parameters expect puts the tendon high on
its force-length curve, where it is very stiff, so a muscle that should be slack at rest pulls
thousands of newtons.

Two things bound what that costs. The tendon curve refuses to extrapolate past ten per cent
strain (`TENDON_MAX_STRAIN`), so the worst a unit can report is about seven and a half times its
own maximum force rather than the 1e44 newtons an unclamped exponential gives; and the fiber
solver flags the unit, which the studio shows as "out of range". One unit in thirty is there at
rest: subscapularis.

The remedy is standard and needs no new constant, because both models can be run here: rescale
optimal fiber and tendon slack so the normalised fiber covers the same operating range over the
joint's range of motion that the source's does. What it costs is provenance -- the scalars become
derived rather than transcribed -- which is a decision rather than a fix, and it is recorded here
until it is made. A guard belongs with it: a derived fiber length far from the source's means the
*path* is wrong, and rescaling would hide that in a parameter.
Half of that remedy has since landed, for the half of the problem that needed no decision about
provenance. Tendon slack length was never transcribed -- it is fitted at compile, because it is a
length measured on the source's bones -- and it is now fitted to the muscle's *travel* rather than
to the rest pose alone: `MUSCLE_LENGTH_RANGES` measures how long each path gets over the range of
the joints it crosses, and `fittedTendonSlack` moves the tendon as far as it must to keep the
fibers between `FIBER_FLOOR` and `FIBER_CEILING` over that travel, and no further. The knee is
where it mattered. A hanging leg is straight, which is one end of the knee's travel rather than
the middle of it, so fitting at rest put the vasti at optimal where they are *shortest* and left
their whole excursion on the descending limb: at 80 degrees of flexion four relaxed extensors
carried 1288 N of passive force against 370 N of active flexion, and a fully driven leg stopped at
84 degrees of its 120 degree range. Fitted to the travel it reaches the stop.

The other half has landed too, and with the guard this entry asked for. Optimal fiber length is
architecture -- fibers long enough for the distance the muscle covers -- and the distance changed
with the bones, so \`deriveOptimalFiberLength\` scales it by how far the muscle travels here against
how far it travelled there. Both travels are measured rather than assumed, by the same sweep on
each skeleton: \`MUSCLE_LENGTH_RANGES\` on ours, \`SOURCE_MUSCLE_TRAVEL\` on the vendored models,
which are rebuilt and run for it.

Running the models rather than reading them is not fastidiousness. A MuJoCo muscle states
\`lengthrange\`, which looks exactly like this measurement: it gives the four vasti, which share
one joint and must travel together, 290, 180, 45 and 172 mm. That attribute is a carrier for the
derivation of the two lengths, not a statement about range of motion. Measured on the running
model the same four come out at 193, 65, 64 and 68 mm -- three vasti that agree and a rectus
femoris that crosses the hip as well.

Two things bound the translation, and both of them are the guard rather than a fix. It only ever
lengthens: a muscle that travels further here needs longer fibers, while less travel than the
source's is not that kind of evidence, and scaling fibers *down* on it turned the quadriceps back
into the splint this was fixing. And it is capped, by a ratio past which the number is no longer
about fibers (\`TRANSLATION_LIMIT\`) and by the share of the path that can be fiber at all with
tendon left over (\`FIBER_SHARE_LIMIT\`). Fourteen of fifty units hit a cap. Each one is a unit
whose path here is longer than the path the parameters were measured on, which is a statement
about its attachments; \`docs/validation/fiber-lengths.md\` lists them, and the generator names them
on every run.

What remains is not a parameter problem. Several biarticular units travel further than any fiber
covers -- biceps femoris long head goes 1.6 optimal fiber lengths over the hip and knee together,
as it does in the source model, whose own fibers run between 0.27 and 1.78 of optimal there. No
fiber length and no tendon length put a band that wide inside a usable part of the curve, and the
muscle is genuinely weak at both ends of it. That is active insufficiency, which a real hamstring
also has; what would change it is the attachment work below, not another scaling.
Fourteen units were capped when that landed. Ten of them were the geometry the caps were there to
point at, and are fixed:

  - The markers are label anchors, placed *beside* a feature so a text label can point at it, and
    measured against the bone each one names not one in the arm lay on it. They are projected onto
    their own bone now (`surfaceLandmarks.ts`). That alone freed brachialis, teres minor and
    infraspinatus, and took the distal humerus from 103.5 mm across to 63.8, which is a human one.
  - The vasti started at one named feature apiece, and a vastus arises along most of the femur.
    Vastus medialis started at the medial supracondylar line -- 93 per cent of the way down the
    bone -- and came out 119 mm long against the 283 of the muscle its parameters describe. A
    muscle whose footprint is long now starts at the middle of it (`footprint` in
    `attachments.ts`), and the three vasti now travel within 3 per cent of what the source's do.
  - Both sweeps were asking for poses no shoulder holds. A shoulder does not elevate with its
    scapula flat, and both models say so -- but a coupling is a constraint the solver satisfies
    during a step, not something `mj_forward` projects, so writing one coordinate left the girdle
    where it was. Each sweep now carries its own couplings, and the reference model gets the
    equality block it was being rebuilt without. The anterior deltoid's travel went from 1.67
    times the source's to 1.08.

Four remain, both sides of two muscles, and both are marginal: the posterior deltoid wants a fibre
3 per cent longer than its path leaves room for, and supraspinatus's transcribed fibre is 89 per
cent of a path that is a fifth shorter than the source's. The rest of what is left is recorded in
OQ-015 rather than here, and brachioradialis has since gone the same way as the vasti: its origin
was the ridge's marker rather than the part of the ridge the muscle arises from, and measuring it
took its travel from 0.38 of the source's to 0.81 and its path from 284 mm to 333 against the
reference's 331.
**Closes when:** the posterior deltoid and supraspinatus paths agree with the source's well enough
that neither needs its fibre trimmed to fit.
**Status:** addressed. Both lengths are derived from measurements on this skeleton rather than
transcribed, with the cited values kept beside them, and the capped list is down from fourteen
units to four.

### OQ-021 — The foot has no frame of its own, and no marked phalanx
**Needed for:** `packages/muscle-data/src/ankle.ts`, `tools/cli/bin/generate-muscle-via-points.mjs`
**Provisional value:** three of the nine ankle muscles run straight from their attachments, and
the four long toe muscles stop at the metatarsals.

*The frame.* Via points are carried from the reference model through one frame correspondence per
limb, fitted at the proximal bone -- the leg's from the hip centre, the knee axis and the femur's
length. One rotation and one scale then carry every point in the limb, and by the ankle they are
out by about twenty millimetres. For a tendon running fifty millimetres behind the joint that is a
rounding error, and the five posterior and lateral muscles come out with moment arms in the
published range: soleus -38 mm at neutral, tibialis posterior -46, fibularis longus -34, both long
flexors -46 and -50. For a tendon running forty in front of it, twenty millimetres is the
difference between a dorsiflexor and nothing:

    at the neutral ankle     carried points    running straight    published
    tibialis anterior              4 mm             51 mm          about 40
    extensor digitorum longus     -2                93             about 30
    extensor hallucis longus      -4                64             about 25

So those three run straight, which is wrong the other way: without the extensor retinaculum
holding them against the front of the ankle they bow away from it and the two extensors come out
two to three times what they should. Both are wrong and this is the less wrong one, because the
sign is right and the muscle is a dorsiflexor at all. The same limitation is noted in OQ-015 for
the forearm, where it costs a few per cent of a bone rather than the sign of a moment.

The remedy is a frame correspondence of the foot's own, fitted at the ankle the way the leg's is
fitted at the hip: the talocrural axis, the ankle centre, and a distal foot landmark both models
carry. The generator already builds exactly this per limb, so what it needs is for a limb to be
able to have more than one, and for a muscle's points to be carried through whichever frame owns
the bone each point sits on.

*The phalanges.* The dataset marks no feature on any of the twenty-eight toe bones -- no
tuberosity, no base, nothing. Extensor and flexor digitorum longus and their hallucis counterparts
insert on the distal phalanges, so each is carried to the head of the metatarsal it runs over and
stops there. They keep their line through the ankle and have none of their action at the toes,
which is all of the toe-off in a stride. The two digitorum muscles fan to four toes apiece and are
carried to the third metatarsal, the middle of the four.
**Closes when:** the foot carries its own frame correspondence, and the toe muscles reach a marked
phalanx or a measured one.
**Status:** open

### OQ-022 — The forearm's actuators do not state their architecture
**Needed for:** the wrist and forearm set, ticket N2.5
**Provisional value:** none. The set is not built, and this is why.

The vendored arm model writes its actuators two ways. The upper arm's are `<general>` elements
whose `gainprm` carries an operating range per actuator -- `0.759864 1.45381 ...` for supinator,
say -- and that range with `lengthrange` determines optimal fiber length and tendon slack length
exactly, which is how every parameter in this project is extracted. The forearm's and the hand's
are `<muscle>` elements: they state `force` and `lengthrange` and nothing else, so the operating
range falls back to MuJoCo's own default of 0.75 to 1.05.

That default is not a statement about any muscle, and deriving lengths from it says so. Against
published architecture the derived fiber lengths come out 1.1 to 5.6 times too long, with no
consistent factor:

    ECRL  93 mm against 81      FCR  119 against 52     FDS3 207 against 73
    ECRB 105 against 59         FCU  131 against 51     EDC2 199 against 57
    ECU   92 against 62         PL   169 against 50     EPL  248 against 44
    PT    77 against 36         PQ    50 against 23, on a tendon of minus 16 mm

Pronator quadratus is the tell: a negative slack length is the same signature `requirePhysical`
refuses for coracobrachialis, `glmax3` and two of the trunk's parts. The numbers are not wrong
arithmetic; the pair they are derived from does not mean what it means elsewhere in the file.

Two of these actuators are written the other way and confirm the reading: anconeus and supinator
are `<general>`, and their derived fiber lengths are 26 mm and 36 mm against a published 27 and 33.

**What could settle it, and why neither candidate can, 2026-09-16.** The spec names the source --
N2.5 is "upper-limb parameter set from Holzbaur 2005" -- and `holzbaur2005` is in the bibliography
as T1. The paper's tables are not vendored the way MyoSuite's XML is, so the model file it
describes was the obvious thing to vendor. It cannot be, and neither can the alternative. Both
were checked against the process in `tools/validate-external/README.md`.

*MoBL-ARMS, the model Holzbaur 2005 and Saul 2015 describe.* Its licence, carried beside the model
as `license.txt`, reads: "open sourced solely for non-commercial purposes ... commercial use
requires a commercial license." That is the MyoSkeleton case exactly, and ADR-009 and ADR-011 have
already decided it: Share-Alike requires every derivative to permit commercial use and a
non-commercial licence forbids it, so the two cannot coexist in one work, and a single copied value
would make the CC BY-SA skeleton data undistributable under either licence. The reason is not
commerce. It is that the two licences cannot be combined.

*`opensim-org/opensim-models`, which carries the Gonzalez, Buchanan and Delp (1997) wrist model.*
That model is the right shape -- twenty-five muscles of the forearm and hand with optimal fiber
length, pennation angle, tendon slack length and peak force stated for every one, which would have
settled the wrist and most of the hand. There is no licence file anywhere in that repository's
tree. The OpenSim application itself is Apache-2.0 and the models are described as distributed
with it, but that is an inference and not a grant, and vendoring on an inference is what the
process exists to stop.

What either could still be is a *behavioural oracle*: read from a path a developer gives in an
environment variable, compared against, never committed and never transcribed, which is exactly
how MyoSkeleton is handled. That would let a travel-derived fiber length be checked against a real
architecture dataset without a value ever crossing.

**The other option, and it is a decision rather than a fix.** Fiber length could be derived the way
this project derives everything else, from travel: a muscle whose path travels a given distance
over its joints' range needs fibers long enough to cover it, and the model already declares how
much of its curve is usable -- `FIBER_CEILING - FIBER_FLOOR`, which is 0.6. Tested against the
fifty-four units whose architecture the source *does* state, predicting optimal fiber length as
travel over 0.7 is unbiased: median ratio 0.96, 33 of 54 within a factor of 1.5 and 46 of 54 within
2. That is a stand-in good to about fifty per cent on any one muscle, which is far better than the
default range gives and is not a transcription. Peak force would still be the source's, and force
is most of what a muscle does.
**What was done instead, 2026-09-16.** The travel route was taken, and in the course of building
it the better version of it turned up. Deriving the fiber length from *our* travel -- the first
plan -- is worse than it looked: our wrist flexes 45 degrees where a real one does 80, and the
forearm's attachment markers sit nearer their joint axes than the muscles do, so these muscles
travel less here than they should. It gave 18, 5, 20 and 23 mm for pronator teres, pronator
quadratus and the two carpi flexors, against a published 36, 23, 52 and 51.

The thing those actuators *do* state is a length range. Divided by the travel a muscle typically
has -- `TYPICAL_NORMALISED_TRAVEL`, two thirds, measured as the median normalised travel of the
fifty-four units whose architecture the source does state -- it lands close:

    pronator teres        34 mm against 36     flexor carpi radialis   53 against 52
    pronator quadratus    23 against 23        flexor carpi ulnaris    59 against 51
    supinator             36 against 33        ext. carpi rad. brevis  63 against 59
    anconeus              26 against 27        ext. carpi rad. longus  42 against 81

Supinator and anconeus are the control: their actuators state an operating range, so those two are
transcribed the ordinary way, and they agree with published architecture to within three
millimetres. Extensor carpi radialis longus is the one that misses, at half.

So the number is a stand-in, it is labelled one, and it is a good one. It passes through the same
travel translation and the same tendon fit as every other set. Peak force is the source's
throughout, and peak force is most of what a muscle does.
**Closes when:** a source that states upper-limb architecture *and may be redistributed alongside
CC BY-SA data* is found and vendored, and the stand-in is replaced by it.
**Status:** answered for now, by a stand-in that is measured rather than assumed. The vendoring
route stays closed until a permissively licensed model turns up. The hand is still not built.

### OQ-023 — The guard that refuses an actuator was written for a value no longer used
**Needed for:** `tools/cli/lib/myoSuite.mjs`, the torso set, and five units in four other sets
**Provisional value:** the guard stands, and the trunk has no extensor because of it.

`requirePhysical` refuses an actuator whose stated operating range and stated length range imply a
tendon slack length at or below zero. Its reason, written when it was: "a negative slack length is
not a value to carry, because the model divides tendon length by it."

That reason has expired. Every tendon is now refitted to this skeleton at compile
(`fittedTendonSlack`), because a slack length is a length measured on the source's bones and means
nothing on ours -- so the source's value is carried as provenance and never used in an equation.
What a negative one now means is that the source's two statements about that actuator disagree,
which is evidence rather than a division by zero.

It matters because the well-conditioned half survives the disagreement. Optimal fiber length comes
out of the *width* of the two ranges, `(LRmax - LRmin) / (rmax - rmin)`, and tendon slack out of
the *offset*, `LRmin - L0 * rmin`. A contradiction in the offset says nothing about the width. For
erector spinae the width gives a 180 mm fiber, which is long but not absurd, while the offset gives
minus 12 mm of tendon, which is impossible -- the source is saying that muscle's whole
musculotendon is 57 mm while its fiber alone is 69.

What refusing costs, counted: erector spinae and rectus abdominis, so the trunk rotates and flexes
and does not extend; coracobrachialis at the shoulder; the inferior part of gluteus maximus; the
middle of latissimus dorsi and the clavicular head of pectoralis major, so that pectoralis does not
flex the arm. Six units, and the trunk's extensor is the one that is missed.

What accepting would cost is a rule with five commits of precedent behind it, and the risk that the
width is not always well-conditioned either -- the detailed lumbar model refuses 146 of 210
fascicles, which is not a handful of bad numbers but a file this project should probably not be
reading muscle by muscle at all.
**Decided, 2026-09-16: narrowed.** `requirePhysical` now refuses only a fiber length at or below
zero, which means the two ranges are not describing the same muscle at all. A negative tendon is
recorded as `tendonImplied: false` and otherwise ignored, because the compiler refits every tendon
to this skeleton and floors it at `MINIMUM_TENDON_SLACK`.

What it restored, and what the compile cap did with each -- the fiber is capped at
`FIBER_SHARE_LIMIT` of its own path, which is what makes an over-long width harmless:

    coracobrachialis              312 mm stated -> 135 compiled, on a 169 mm path
    gluteus maximus, inferior     408 -> 50, on 63
    latissimus dorsi, lumbar      395 -> 395, on 500
    pectoralis major, clavicular  189 -> 140, on 175
    erector spinae                180 -> 180, on 379
    rectus abdominis              326 -> 306, on 382

Six units, and the one that mattered is erector spinae: the trunk extends now. Pectoralis major
flexes the arm again, gluteus maximus has its third part, and coracobrachialis is back after four
commits out. None of the six exceeds four fifths of its own path once compiled, and three of them
were never touched by the cap at all.

The risk that remains is the one this entry named: the width is not always well conditioned
either. The detailed lumbar model still refuses 146 of 210 fascicles on the width alone, which is
the check doing its job.
**Status:** closed.

### OQ-016 — Geodesics on an ellipsoid, which have no closed form
**Needed for:** `packages/muscle-path/src/wrap.ts`, ticket N1.4
**Provisional value:** none. A path that names an ellipsoid wrap surface is refused at compile
time rather than approximated. The sphere and the cylinder both have closed-form geodesics -- a
great circle on one, a helix on the other -- so N1.4 implements those exactly, in trigonometry
rather than iteration. An ellipsoid has neither, and the usual shortcut of scaling it to a sphere,
solving there and scaling back does not give a geodesic at all, because scaling does not preserve
them; it gives a plausible path that is not the shortest one and whose moment arm is wrong by an
amount nobody has measured.

It also has no consumer yet. MuJoCo's tendon wrapping supports spheres and cylinders and nothing
else, so the vendored reference arm model's wrap geometry is entirely spheres and cylinders -- the
geoms with "ellipsoid" in their names carry no `type` attribute, which makes them MuJoCo's default,
a sphere. Finding that is also what corrected the HSDL wrapping-surface schema, which allowed
cylinders and ellipsoids and claimed that matched MuJoCo; it now allows spheres as well.
**Closes when:** N1.5 lands. Natural Geodesic Variations already parameterises a geodesic by its
start point, start direction and length and solves numerically, so the ellipsoid belongs there
rather than in a second, worse iterative solver written here and thrown away.
**Status:** open

### OQ-017 — The specific tension of muscle tissue
**Needed for:** `packages/muscle-volume/src/sweep.ts`
**Provisional value:** 0.45 MPa. It converts a muscle's maximum isometric force into a
cross-sectional area, and so into the volume the drawn belly encloses. Published values range
from roughly 0.2 to 0.6 MPa and the spread is real rather than disagreement: it depends on the
preparation, the species, and how the area was measured. Rather than take one from the middle,
the value is calibrated against the quantity it produces, because muscle volumes are measured
directly and published: at 0.3 MPa this set comes out 30 to 60 per cent larger than published
volumes for every muscle in it, and at 0.45 each one lands in range -- biceps 226 cm3 against
250-300, brachialis 150 against ~140, brachioradialis 62 against 60-90, triceps 439 against
370-450. A number calibrated against other numbers is not the same thing as a number read out of
a paper, so it is recorded here rather than cited, and what it was calibrated against should be
checked before it is trusted.

What the uncertainty costs is bounded and stated. Tier V writes only to the render channel
(M-ADR-004), so the consequence is that every muscle is drawn some per cent too thick or too
thin, uniformly across the model. It does not reach the dynamics. And the thing the tier exists
to show -- that a contracting muscle thickens -- does not depend on it at all: the bulge comes
from holding the belly's volume constant as the fibers shorten, whatever that volume is.

One second-order effect is worth naming, because it is the reason the value was revisited at all.
The volume also sets how long the belly of a pennate muscle is drawn: a belly that would come out
wider than it is long is spread along the path until it is not (`MAX_WIDTH_OVER_LENGTH`), and how
far it spreads follows from the volume. So a wrong specific tension moves the drawn length of the
three most pennate units in the elbow set, not only their girth.
**Closes when:** a specific tension with a stated preparation and measurement method is cited, or
the muscle meshes come from an anatomical asset pack and their volumes are measured rather than
derived (section 9.4 allows for that as an upgrade).
**Status:** open

### OQ-018 — How much a muscle belly's volume moves with contraction
**Needed for:** `packages/muscle-volume/src/sweep.ts`
**Provisional value:** three per cent at full activation and full contraction velocity. Muscle
tissue is water and does not compress, so the tissue volume is fixed; a belly is not only tissue,
and how much blood it holds depends on what it is doing. Shortening under load squeezes it out --
the muscle pump -- so a concentric contraction measures slightly smaller; lengthening under load
raises intramuscular tension without that expulsion and can measure slightly larger; held at
length, nothing moves.

The magnitude is the uncertain part. Published figures vary with the method -- ultrasound, MRI
and plethysmography do not agree closely, and they are measuring somewhat different things. Three
per cent is a small number chosen to be visible without being assertive.

Like OQ-017 this reaches only the render channel (M-ADR-004), and it is separable: the geometry
that makes a shortening belly thicken knows nothing about it, and a caller wanting the classical
incompressible idealisation simply does not apply it.
**Closes when:** a figure with a stated measurement method is cited, or the effect is judged not
worth drawing and the modulation is removed rather than left at a guess.
**Status:** open

### OQ-019 — How a muscle's tendon divides between its two ends
**Needed for:** `packages/muscle-volume/src/sweep.ts`
**Provisional value:** half at each end. The swept belly is the path less its tendon, which is
what puts the flesh where it belongs and holds it there while the path shortens -- but the
musculotendon model carries one tendon slack length per unit, not one per end, so there is a
total to place and nothing in the parameters to divide it by. Centring the belly splits it evenly.

That is wrong for several muscles in this set and it is wrong visibly. The long head of biceps is
the clear case: almost all of its tendon is proximal, running over the humeral head and down the
bicipital groove, while the distal tendon to the radial tuberosity is short. Drawn evenly, its
belly sits a few centimetres lower on the arm than it should.

**Partly answered, 2026-09-16, by the one thing the model does know.** A muscle belly does not lie
across a joint -- tendon does, and that is what tendon is for. It is why the fleshy part of a calf
stops well above the heel and the fleshy part of a forearm well above the wrist. Where the joints
are is something the model has: `jointCrossings` measures, per unit at compile, where each joint
the muscle crosses falls along its path, and `bellyPlacement` slides the drawn belly off them.

The restraint is the design. It slides as little as it takes, a belly that already clears
everything does not move at all, and a belly that fits in no clear stretch keeps the middle. Two
looser rules were tried first and both were worse: centring the belly in the *longest* clear
stretch moved thirty-nine muscles of fifty-four including ones that were already right, and put
flexor digitorum longus's flesh in the sole of the foot because the sole is the longer stretch of
its path; sliding off each joint in turn left sartorius, which is four fifths of its own path and
fits nowhere, jammed against its origin having cleared one joint of two.

What it changed, over the fifty-four units of one side: bellies straddling a joint fell from
twenty-one to fourteen, and four muscles moved by more than ten millimetres -- gluteus medius and
minimus back onto the ilium, piriformis into the pelvis, the middle deltoid out over the shoulder.
The fourteen that remain are bellies longer than any clear stretch of their own path, which is
brachialis at nine tenths of its and sartorius at four fifths: a muscle that long against its
bones does lie over a joint.

What is still open is the half this cannot reach. Within a clear stretch the belly is still
centred, because nothing in the parameters says where in the calf a gastrocnemius keeps its flesh
against where a soleus keeps its. The long head of biceps is the case as before: its tendon is
almost all proximal and the model has no way to know.

Nothing downstream depends on any of it: Tier V writes only to the render channel (M-ADR-004), the
moment arm comes from the path and not from where the flesh is drawn along it, and the belly's
length -- which is what sets its thickness -- does not change with how the tendon is divided. The
full test suite passes with no golden moving, which is that boundary being real.
**Closes when:** the muscle geometry carries a tendon length per end, either from an anatomical
asset pack whose muscle meshes show where the belly actually begins (section 9.4) or from a source
that reports proximal and distal tendon lengths separately.
**Status:** partly addressed -- the belly is off the joints; where it sits between them is still a
guess.
