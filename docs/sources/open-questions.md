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
**Closes when:** per-muscle pennation angles are transcribed from a source that states them
(Holzbaur 2005 does, for this region), and the peak forces are re-derived alongside them so the
two stay consistent. Taking the angles alone would double-count the pennation the forces already
include.
**Status:** open

### OQ-015 — The elbow muscle paths are straight lines, with the wrapping not yet modelled
**Needed for:** `packages/muscle-data/src/elbow.ts`, `packages/muscle-path`
**Provisional value:** every unit runs straight from origin to insertion. Every one of them wraps
in the source model -- brachialis over a cylinder, each biceps head over two ellipsoids, both with
via points between -- and two things are missing before that can be carried over. The wrap
geometry and the via points are in MyoSuite's body frames, which are not this project's, so they
need the frame reconciliation the scalar parameters did not; and the path solver cannot wrap yet,
which is ticket N1.4. A straight line holds the muscle closer to the joint axis than it runs, so
it understates the moment arm, most at full flexion where the wrapping is doing the most work.

**Worse than that, measured.** Running the units through `muscle.dynamics` at L3 (N3.2) shows the
error is not confined to the moment arm. A straight path is also *shorter* than the wrapped one,
and the tendon slack lengths were fitted against the wrapped paths, so for three of the seven
units the whole path is shorter than the tendon slack length plus the fibers: the tendon never
loads and the muscle makes no force at all however hard it is driven. Biceps long head runs
0.302 m against a resting length of 0.404 m; the lateral and medial heads of triceps run 0.093 m
against 0.196 m and 0.183 m. The four that do load -- biceps short head, brachialis,
brachioradialis and the long head of triceps -- behave correctly. A test in
`packages/modules-muscle` asserts exactly which three are slack, so that authoring the wraps
fails it and forces this question to be revisited rather than quietly closed.
**Closes when:** N1.4 lands and the via points and wrap surfaces are expressed in this project's
bone frames -- either by reconciling MyoSuite's frames against ours, or by locating the surfaces
on this subject's own bone geometry the way M5.8 located the collision hulls.

**Half closed, 2026-09-15.** The second route was taken: the humeral trochlea is measured from
this subject's own mesh (18.0 mm radius about the epicondylar axis, +/- 3.0 mm, half-length
9.6 mm) and placed on the elbow joint's own axis, so it is coaxial with the joint by construction
-- 0.000 mm of offset and 0.0000 degrees of tilt. All seven units now turn over it, the flexors in
front and the extensors behind.

What that fixed: the triceps moment arm used to fall from -20.0 mm at full extension to zero at
about 2 rad and then reverse sign, so a fully driven triceps held a bent elbow bent. It now holds
flat at -18.0 mm -- the surface's radius, which is what a pulley gives and what published curves
show -- from 1.2 rad onward.

What is still open, and why this is only half:

- **The flexors do not wrap.** Their straight paths pass in front of the trochlea and clear it, so
  biceps still peaks at 65 mm against a published 36-40 mm, biceps short head still reverses sign
  at 2.4 rad, and brachioradialis still reverses at full extension. In life they turn over the
  radial head and the coronoid region, not the trochlea. A second surface is needed, and the path
  solver takes one per span until N1.5 adds the multi-surface solve -- so this needs either a via
  point splitting the span or that ticket.
- **The via points are still absent.** The source model routes several units through points along
  the shaft. Those shift where a muscle sits without changing what it turns over, so the moment
  arms are right without them, but the lines are straighter than the real ones. They are in
  MyoSuite's frames, which are not ours.
- **Several tendons are still slack.** The wrapping lengthened the paths -- the long head of
  triceps went from 45 mm short of its resting length to 0 at full flexion -- but the lateral and
  medial heads remain 75-120 mm short and cannot load at any angle. Their parameters were fitted
  against paths with via points; without those the geometry is still too short.

**Status:** open


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
**Provisional value:** 0.3 MPa. It converts a muscle's maximum isometric force into a
cross-sectional area, and so into the volume the drawn belly encloses. Published values cluster
between roughly 0.2 and 0.35 MPa and the spread is real rather than disagreement: it depends on
the preparation, the species, and how the area was measured. A number in the middle of a
published range is not the same thing as a number read out of a paper, so it is recorded here
rather than cited.

What the uncertainty costs is bounded and stated. Tier V writes only to the render channel
(M-ADR-004), so the consequence is that every muscle is drawn some per cent too thick or too
thin, uniformly across the model. It does not reach the dynamics. And the thing the tier exists
to show -- that a contracting muscle thickens -- does not depend on it at all: the bulge comes
from holding the belly's volume constant as the fibers shorten, whatever that volume is.
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
