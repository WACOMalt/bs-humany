# Bibliography

Every range of motion, mass fraction, dimension and landmark definition in the core packages
carries a citation key that resolves against this file. `pnpm cite:lint` fails on an unknown key.

**A number without a source is a bug** (CONTRIBUTING rule 3).

## Citation format

In code:

```ts
import { cite } from '@bs-humany/hsdl';

romSource: cite('wu2002', 'Table 1, hip flexion/extension'),
```

The key is the lowercase first-author surname plus publication year. The locator is free text
naming the table, figure, section or page the value was read from — specific enough that a reviewer
can find the number without re-reading the paper.

## Provenance tier

Every entry is tagged with the tier from ADR-009 that it may be used in.

- **T1** — usable in core packages. No redistribution restrictions.
- **T2** — asset packs only. Share-Alike obligations propagate.
- **T3** — developer-local validation tooling only. Behavioral oracle, **never** a value source.

---

## Anthropometry and segment inertia

### `deleva1996` — T1
de Leva, P. (1996). Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters.
*Journal of Biomechanics*, 29(9), 1223–1230. doi:10.1016/0021-9290(95)00178-6

The load-bearing citation for segment inertial parameters. Gives, as **separate male and female
tables**, relative segment masses as a fraction of total body mass, longitudinal centre-of-mass
positions as a fraction of segment length from the proximal joint centre, and principal radii of
gyration — all referenced to **joint centres** rather than the skin landmarks of the original
Zatsiorsky gamma-ray scanning study.

*Population limitation, to be surfaced in the UI:* source sample is college-aged Caucasian adults
(n=100 male, n=15 female). Not a universal human norm.

### `zatsiorsky1990` — T1
Zatsiorsky, V. M., Seluyanov, V. N., & Chugunova, L. G. (1990). Methods of determining
mass-inertial characteristics of human body segments. In *Contemporary Problems of Biomechanics*,
272–291. CRC Press.

Upstream of `deleva1996`. Cite only where de Leva's adjustment is not what is wanted.

### `dumas2007` — T1
Dumas, R., Chèze, L., & Verriest, J.-P. (2007). Adjustments to McConville et al. and Young et al.
body segment inertial parameters. *Journal of Biomechanics*, 40(3), 543–553.

Alternative sex-specific set with **full inertia tensors including off-diagonal terms**. Reserve
for the case where the principal-axis assumption in `deleva1996` proves inadequate.

### `gordon2014` — T1
Gordon, C. C., Blackwell, C. L., Bradtmiller, B., Parham, J. L., Barrientos, P., Paquette, S. P.,
Corner, B. D., Carson, J. M., Venezia, J. C., Rockwell, B. M., Mucher, M., & Kristensen, S. (2014).
*2012 Anthropometric Survey of U.S. Army Personnel: Methods and Summary Statistics* (ANSUR II).
Technical Report NATICK/TR-15/007. US Army Natick Soldier Research, Development and Engineering
Center.

US federal government work, no restrictive licensing. Supplies traditional linear measurements plus
3D body scans across a large sample (n=4082 male, n=1986 female), sex-separated at source. The
dimensional backbone for the morphology system and the source of the percentile axis.

*Population limitation, to be surfaced in the UI:* sampled US military personnel, who are not
representative of the general population in body composition or age distribution.

### `drillis1966` — T1
Drillis, R., & Contini, R. (1966). *Body Segment Parameters*. Report 1166-03, Office of Vocational
Rehabilitation, Department of Health, Education and Welfare, New York.

The origin of the widely-reproduced table of segment lengths as fractions of standing height. Used
here for the segment-length proportions that ANSUR II does not measure directly.

*Limitation, to be surfaced in the UI:* **not sex-separated.** Applying one set of proportions to
both endpoint tables understates real dimorphism in limb proportion. Tracked as OQ-003.

### `winter2009` — T1
Winter, D. A. (2009). *Biomechanics and Motor Control of Human Movement* (4th ed.). Wiley.

The standard modern reproduction of `drillis1966`'s proportion table, and the form in which those
fractions are usually cited. Cite alongside `drillis1966` rather than instead of it.

---

## Joint coordinate conventions

### `wu2002` — T1
Wu, G., Siegler, S., Allard, P., Kirtley, C., Leardini, A., Rosenbaum, D., Whittle, M.,
D'Lima, D. D., Cristofolini, L., Witte, H., Schmid, O., & Stokes, I. (2002). ISB recommendation on
definitions of joint coordinate system of various joints for the reporting of human joint motion —
part I: ankle, hip, and spine. *Journal of Biomechanics*, 35(4), 543–548.

### `wu2005` — T1
Wu, G., van der Helm, F. C. T., Veeger, H. E. J., Makhsous, M., Van Roy, P., Anglin, C., Nagels, J.,
Karduna, A. R., McQuade, K., Wang, X., Werner, F. W., & Buchholz, B. (2005). ISB recommendation on
definitions of joint coordinate systems of various joints for the reporting of human joint motion —
part II: shoulder, elbow, wrist and hand. *Journal of Biomechanics*, 38(5), 981–992.

Together these define standard segment coordinate systems and joint coordinate systems **from bony
landmarks described textually as palpable features**. That textual definition is what makes them a
lawful measurement source under ADR-009 — no mesh required.

Adopting them means joint angles here are directly comparable to published literature and to
motion-capture pipelines, at essentially zero implementation cost beyond care in frame definition.

---

## Musculoskeletal models

### `rajagopal2016` — T1
Rajagopal, A., Dembia, C. L., DeMers, M. S., Delp, D. D., Hicks, J. L., & Delp, S. L. (2016).
Full-body musculoskeletal model for muscle-driven simulation of human gait. *IEEE Transactions on
Biomedical Engineering*, 63(10), 2068–2079.
Model freely distributed via SimTK: `simtk.org/projects/full_body`

22 rigid bodies, 37 DoF, 80 Hill-type lower-limb muscle-tendon units, 17 upper-body torque
actuators. Parameters derived from 21 cadaver specimens and MRI of 24 subjects. **Body coordinate
frames documented relative to bony landmarks.**

Adopted as the reference for joint definitions, DoF allocation and body frames in the lower limb
and the general body plan. Known limitation: does not articulate the cervical spine. Published
augmentations add cervical and sternoclavicular joints.

### `seth2010` — T1
Seth, A., Sherman, M., Eastman, P., & Delp, S. (2010). Minimal formulation of joint motion for
biomechanisms. *Nonlinear Dynamics*, 62(1), 291–303.

The reduced-coordinate joint formulation underlying OpenSim. Relevant to the per-DoF decomposition.

### `caggiano2022` — T1
Caggiano, V., Wang, H., Durandau, G., Sartori, M., & Kumar, V. (2022). MyoSuite — A contact-rich
simulation suite for musculoskeletal motor control. *Proceedings of Machine Learning Research
(L4DC)*. arXiv:2205.13600. **Apache-2.0.**

MuJoCo conversions of OpenSim models (`myoLeg`, `myoArm`, `myoHand`, `myoTorso`). Adopted as
reference for how OpenSim biomechanics maps onto MJCF. Apache-2.0, so usable in core **and** in CI.

### `wang2022` — T1
Wang, H., Caggiano, V., Durandau, G., Sartori, M., & Kumar, V. (2022). MyoSim: Fast and
physiologically realistic MuJoCo models for musculoskeletal and exoskeletal studies. *ICRA 2022*.

### `caggiano2024` — **T3 — ORACLE ONLY**
Caggiano, V., et al. (2024). MyoSkeleton: A Universal Human Skeletal Model. MyoLab Inc. white paper.

> **Non-commercial research license. Reference oracle only.**
> Full-body, 152 DoF, all spinal levels articulated, governed by 66 equality constraints coupling
> adjacent vertebral levels.
>
> **Do not transcribe values from this model into any core package.** Compare behavior — joint
> axes, ranges of motion, coupling distribution — and when a discrepancy appears, resolve it by
> finding a citable source, not by adopting this model's number. See ADR-009 and CONTRIBUTING §11.

---

## Passive joint properties

### `riener1999` — T1
Riener, R., & Edrich, T. (1999). Identification of passive elastic joint moments in the lower
extremities. *Journal of Biomechanics*, 32(5), 539–544.

The standard reference form for passive joint moment curves: double-exponential resistance rising
near end-range. A hard range stop alone produces a ragdoll that looks like a puppet — limbs swing
freely then slam into invisible walls. This is the citation for why they do not.

Coverage is lower-limb (hip, knee, ankle). Upper-limb and spinal passive curves are an open
question — see `open-questions.md`.

---

## Software

| Project | URL | License |
|---|---|---|
| MuJoCo | `github.com/google-deepmind/mujoco`, WASM bindings under `/wasm` | Apache-2.0 |
| Rapier | `rapier.rs`, `github.com/dimforge/rapier` | Apache-2.0 |
| three.js | `threejs.org` | MIT |
| OpenSim | `opensim.stanford.edu` | Apache-2.0 |

## Anatomical mesh datasets — data tier, CC BY-SA (ADR-009 as revised, ADR-011)

### `mitsuhashi2009` — data tier
Mitsuhashi, N., Fujieda, K., Tamura, T., Kawamoto, S., Takagi, T., & Okubo, K. (2009). BodyParts3D:
3D structure database for anatomical concepts. *Nucleic Acids Research*, 37(suppl_1), D782–D785.
Dataset: Database Center for Life Science, `dbarchive.biosciencedbc.jp/en/bodyparts3d`. **CC BY-SA
2.1 JP.** Required attribution: "BodyParts3D, (c) The Database Center for Life Science licensed
under CC Attribution-Share Alike 2.1 Japan".

The upstream of Z-Anatomy. One male subject, segmented from MRI, in the anatomical position. Ships
per-structure OBJ (millimetres, Z-up) keyed by FMA concept id.

### `kervyn2021` — data tier
Kervyn, G., Zielinski, M., Vinent, L., et al. (2021–). Z-Anatomy: the libre 3D atlas of anatomy.
`z-anatomy.com`; models at `github.com/Z-Anatomy/Models-of-human-anatomy`; the FBX export used here
at `github.com/LluisV/Z-Anatomy` (`Resources/Models/FBX/SkeletalSystem100.fbx`). **CC BY-SA 4.0.**
Required attribution: "Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0".

Cleaned and re-named BodyParts3D geometry, in the FBX frame `x: left, y: superior, z: anterior`,
centimetres. Carries 36-vertex marker primitives at named anatomical features on each bone, which
is the source of the landmark table. **Primary source of bone shape, placement and landmarks as of
spec 0.5.** Includes NC-licensed inner-ear material from Dundee that must not be ingested — see
OQ-004.

## Legacy note

| Project | URL | License |
|---|---|---|
| Z-Anatomy | `z-anatomy.com`, `github.com/Z-Anatomy` | CC BY-SA 4.0 |
| BodyParts3D | Database Center for Life Science | CC BY-SA 2.1 JP |
| AnatomyTOOL Open 3D Anatomical Model | `anatomytool.org/open3dmodel` | CC BY-SA |

The 0.4 rule that meshes may render but not measure was withdrawn in spec 0.5 (ADR-011). The table
above is retained for the URLs.

### `gray1918` — T1
Gray, H. (1918). *Anatomy of the Human Body*, 20th edition, revised by W. H. Lewis. Lea &
Febiger, Philadelphia. **Public domain.**

The source for muscle origins and insertions as bony features: which tubercle, crest, fossa or
line a muscle attaches to. Used for the attachment sites of M5.3, where the dataset's marker of
that feature is the *location* and Gray is the *statement* that the muscle attaches there
(ADR-011's split between what a landmark is and where this subject has it). Locators name the
muscle's section in Part IV, Myology.
