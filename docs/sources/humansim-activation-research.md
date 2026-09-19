# HumanSim — Muscle Activation Authoring

**Research report and design for the activation keyframe system**

| | |
|---|---|
| Document | `humansim-activation` |
| Version | 0.2 |
| Status | Research complete. Design proposed. Reference clips supplied and bound to the repository. |
| Changes in 0.2 | Section 1 replaced with an actual repository review. Clip identifiers bound to real `muscle-data` ids. Scapulothoracic gap found. Companion file written. |
| Depends on | `humansim-spec` v0.4, `humansim-muscle-spec` v0.1 |
| Companion file | `activation-clips.json` — 27 weighted groups, 3 clips, all ids verified against `muscle-data` |
| Prose style | ASD-STE100 Issue 9, flavored mode |

---

## 0. Summary for the impatient

Four findings drive the design.

1. **Do not author per-muscle keyframes.** Four to five muscle synergies account for 91% to 93% of the electromyography variance in walking. Three account for over 85%. Author synergy primitives and a weight matrix. Let the tool expand them into per-muscle activation.
2. **Timing is published. Amplitude is not.** Onset and offset instants for gait are well documented as a percentage of the gait cycle, across thousands of strides. Amplitudes vary with the normalization method and are much less portable.
3. **The derivation route exists and we already own most of it.** Bone animation, then inverse kinematics, then inverse dynamics, then static optimization against joint moments. Our muscle module already computes moment arms and fiber force, which are the two inputs static optimization needs.
4. **Feed excitation, not activation.** Electromyography approximates neural drive, which is the excitation input `u`. Our activation dynamics then produce the 50 millisecond electromechanical delay by themselves. Writing keyframes straight into activation would double-count the delay.

Reference clips for quiet standing, walking, and arm flailing are in the companion JSON file.

---

## 1. The repository

Reviewed at commit HEAD of `github.com/WACOMalt/bs-humany`. The earlier version of this document could not reach it. It is reachable now, and the review changes three things in this document and confirms a fourth.

### 1.1 What is already built

The package layout follows the muscle specification: `muscle-model`, `muscle-path`, `muscle-data`, `modules-muscle`, `muscle-volume`, plus `tools/validate-external/myo_sim` holding MyoSuite reference models. Region generators exist for elbow, forearm, shoulder, knee, hip, ankle, torso and trunk.

### 1.2 Confirmed: excitation, not activation

Section 3.6 of this document is correct and the code matches it. `EFFERENT_ALPHA_MOTOR` carries a field named `excitation`. `muscleDynamicsModule` reads it and calls `stepActivation(activation, excitation, dt)`. `DEFAULT_ACTIVATION_TIME` is 0.01 s and `DEFAULT_DEACTIVATION_TIME` is 0.04 s, matching the 10 and 40 millisecond figures this document assumed.

`MINIMUM_ACTIVATION` is 0.001. That floor sits well below the lowest value used in the standing clip, about 0.02, so it does not interfere. Worth knowing for a clip that tries to drive a muscle to true zero: it will settle at the floor instead.

### 1.3 Changed: the keyframe format already exists, partly

`MuscleTestDriveModule` exposes a `DrivePattern` union with four kinds, and `scripted` takes `points: { time, level }[]`, linearly interpolated and held flat outside the range. That is a keyframe track and no new playback machinery is needed.

Three gaps between that type and the format section 3 of this document specifies. Each is a ticket rather than a redesign:

| Needed | Present | Gap |
|---|---|---|
| `cyclePercent` timebase with a declared period | Absolute seconds only | A cyclic clip must be expanded to seconds at load, and cannot be retimed afterwards. |
| Monotone cubic interpolation | Linear only | Linear keyframes on a 0.3 Hz sway curve need many more breakpoints to look smooth. |
| Weighted group targets | `units: string[] \| 'all'`, all driven to the same level | A group cannot express that soleus and gastrocnemius do different jobs. Section 3.3 requires weights. |

### 1.4 Changed: the functional groups do not exist

Section 3.3 lists 27 weighted functional groups. None are defined anywhere in the repository. The companion file therefore ships them, with weights, as its first section. They are the prerequisite for every group-targeted track.

### 1.5 Changed: a muscle set gap that affects one clip

`muscle-data` has the full rotator cuff: supraspinatus, infraspinatus, subscapularis, teres minor, plus teres major. It has **no scapulothoracic muscles at all**. No trapezius, no serratus anterior, no rhomboids, no levator scapulae.

Section 4.3 of this document specifies holding the scapular stabilizers near 0.2 during flailing, and notes that without this the arm drags the shoulder girdle and the motion looks dislocated. That track cannot be written. The companion file declares the `scapular_stabilizers` group with an empty weight map, so the gap is visible in the data rather than silently missing, and substitutes raised rotator cuff activity as the nearest available bracing. It is not equivalent.

Note that Holzbaur et al. (2005), the upper-limb parameter source named in the muscle specification, does not include these muscles either. A shoulder model that does is van der Helm (1994). This is a `muscle-data` ticket, not a clip problem.

### 1.6 Confirmed: in-engine derivation is viable

Static optimization needs net joint moment, moment arms, and muscle force capacity at the current length and velocity. All three are present: `muscle.moment` publishes moment arms, `muscle-model` computes force capacity, and base specification obligation 4 makes realized per-degree-of-freedom force readable. Section 5.1 can be built without OpenSim in the loop.

---

## 2. Where this information comes from

### 2.1 Timing data for gait

Timing is the strong part of the literature. Onset and offset instants are reported as a percentage of the gait cycle, and they replicate well across studies.

| Source | Content |
|---|---|
| Perry, J., & Burnfield, J. (2010). *Gait Analysis: Normal and Pathological Function*, 2nd ed. | The standard reference. Phase-by-phase muscle activity for the whole lower limb, with the gait cycle divided into eight named phases. Start here. |
| Winter, D. A. (2009). *Biomechanics and Motor Control of Human Movement*, 4th ed. | Normative kinematics, kinetics and electromyography. Includes the joint moment data that a derivation pipeline needs. |
| Agostini, V., et al. (2010). Normative EMG activation patterns of school-age children during gait. *Gait & Posture*. | 100 subjects, about 28,000 strides. Onset and offset for tibialis anterior, lateral gastrocnemius, vastus medialis, rectus femoris and lateral hamstrings, both limbs. |
| Di Nardo, F., et al. (2013). Assessment of the activation modalities of gastrocnemius lateralis and tibialis anterior during gait. | 14 adults. Reports that muscles have several distinct activation modalities across strides of the same walk, and identifies one common pattern per muscle. |
| Strazza, A., et al. (2017). Surface-EMG analysis for the quantification of thigh muscle dynamic co-contractions during normal gait. *Gait & Posture*. | 30 adults, 16,315 strides. Quantifies quadriceps against hamstring co-contraction with onset and offset. |

A useful finding from Di Nardo: a single muscle shows large variability in the number of activation intervals and in the on and off instants between strides of the same walk. A single deterministic keyframe track is therefore an average, not a truth. Section 6.4 covers what to do about that.

A useful finding from Strazza: medial hamstrings overlap both vastus lateralis and rectus femoris from terminal swing, 80% to 100% of the cycle, into the following loading response at about 0% to 15%, in around 90% of strides. This co-contraction is real and it should appear in the clips.

### 2.2 Standing balance

The physiology here is specific and it contradicts the intuitive approach.

During quiet standing the center of mass sits slightly anterior to the ankle, so the body needs a continuous plantarflexor moment to avoid falling forward. The soleus supplies most of it. The soleus is monoarticular, it has a large physiological cross-sectional area, and roughly 80% of its fibers are type I, which suits it to sustained low-intensity work.

The division of labor between the two main plantarflexors matters for authoring:

- **Soleus** shows relatively stable tonic activity. It carries body weight.
- **Medial gastrocnemius** shows large fluctuations synchronized with center-of-mass sway. It damps the sway.

So a standing clip needs one flat track and one oscillating track, not two flat tracks.

The tibialis anterior behaves differently again. It fires in intermittent bursts rather than continuously. During those bursts the plantarflexors do not switch off, so the ankle briefly co-contracts. One study measured plantarflexor activity at roughly 100% of the standing duration, and used a 2.5% maximum voluntary contraction threshold to detect activity at all. Quiet standing is a low-amplitude task.

**The important negative result:** raising ankle co-contraction does not improve balance. Sway amplitude measures rose by 37.5% to 63.2% at co-contraction levels of 30% and 40% maximum voluntary contraction, and frequency measures rose by 30.5% to 154.2%. Deliberate stiffening makes standing worse.

This has a direct consequence for the tool. If a user drags all the leg sliders up to stabilize a falling model, the model should get *less* stable, and that is correct behavior rather than a bug. Document it.

### 2.3 Muscle synergies

This is the finding that should shape the feature.

| Source | Result |
|---|---|
| Kim, Y., et al. (2016). Novel methods to enhance precision and reliability in muscle synergy identification during walking. *Frontiers in Human Neuroscience*. | Eight leg muscles, bilateral, 20 consecutive gait cycles. Identifies four or five reliable synergies for walking in unimpaired adults. Also shows that some extracted synergies have poor reproducibility and should be rejected. |
| Rabbi, M. F., et al. (2020). Non-negative matrix factorisation is the most appropriate method for extraction of muscle synergies in walking and running. *Scientific Reports*. | Ten lower-limb muscles. Three synergies account for over 85% of the variance in muscle activation patterns at all tested gait speeds. Compares four factorization methods and recommends non-negative matrix factorization. |
| Zandvoort, C. S., et al. (2019). Muscle synergies and coherence networks reflect different modes of coordination during walking. | 26 bilateral muscles across the whole body. Five relevant synergies. Activation patterns differ between one-to-one and two-to-one arm-leg coordination. |
| Ivanenko, Y. P., Poppele, R. E., & Lacquaniti, F. (2004). Five basic muscle activation patterns account for muscle activity during human locomotion. *Journal of Physiology*. | The classic result. Five patterns, each with a timing peak tied to a gait event. |

A factorization yields two things: **synergy weights**, which say how much each muscle belongs to each synergy, and **excitation primitives**, which are the time courses. The weights scale the primitive intensity to produce the time-varying neural command.

Five numbers over time, times a weight matrix, reproduces most of walking. That is a tractable authoring surface. Six hundred independent tracks is not.

### 2.4 Open data and models

| Resource | Content | Note |
|---|---|---|
| Fukuchi, C. A., Fukuchi, R. K., & Duarte, M. (2018). A public dataset of overground and treadmill walking kinematics and kinetics. *PeerJ*. | 42 adults, several speeds, full kinematics and kinetics | Good input for the derivation pipeline. |
| AddBiomechanics (Stanford) | Automated scaling and inverse kinematics on uploaded motion capture, with a growing public dataset | Useful for scaling a model to a specific subject. |
| MyoSuite, MyoChallenge | Apache 2.0 MuJoCo musculoskeletal models, plus trained control policies | A trained policy is an activation generator. See section 5.3. |
| Ninapro | Large surface electromyography database for hand and forearm | Relevant later, for hand work. |
| SCONE and Hyfydy example scenarios | Reflex-based gait controllers | See section 5.2. |

### 2.5 What is genuinely hard to source

Be honest about the gaps, because an implementing agent will otherwise invent numbers.

- **Amplitude in absolute terms.** Electromyography is normalized, usually to a maximum voluntary contraction, and the normalization choice changes the numbers. Published amplitudes are comparable within a study and shaky between studies.
- **Trunk and deep muscles.** Surface electrodes cannot reach the psoas, the deep spinal muscles, or most of the shoulder girdle. Data comes from fine-wire studies with small samples.
- **Arm flailing and other unstructured motion.** There is no normative dataset for a non-task. Section 7.3 handles this by construction rather than by citation.
- **Upper limb during walking.** Arm swing electromyography exists but it is sparse compared with the lower limb.

---

## 3. The authoring model

### 3.1 Three layers

Give the user three ways to specify activation. Each compiles down to the same channel.

```
Layer 3  Behaviors      "stand", "walk at 1.3 m/s"   parameterized, generated
   |
Layer 2  Synergies      5 primitives x weight matrix  the recommended authoring surface
   |
Layer 1  Direct tracks  per muscle or per group       full control, tedious
   |
   v
efferent.alphaMotor     excitation per muscle-tendon unit, 0 to 1
```

A clip MAY mix layers. A synergy clip with one direct override track is a normal thing to want.

### 3.2 Targets

A track targets one of:

| Target type | Example | Expansion |
|---|---|---|
| `unit` | `soleus_r` | Itself. |
| `group` | `plantarflexors` | Every unit in the named group, scaled by the group's per-unit weight. |
| `synergy` | `synergy.weight_acceptance` | Every unit with a nonzero weight in that synergy. |
| `bundle` | `deltoid_r` | The parallel units of one anatomical muscle, per muscle spec M-ADR-005. |

Every target carries an explicit side: `left`, `right`, or `both`. The project owner asked for separated left and right control, so side is a required field and not a modifier. `both` expands to two tracks at compile time, so a later edit can break the symmetry without restructuring the clip.

### 3.3 Group definitions

Groups need per-unit weights, not flat membership. A `plantarflexors` group that drives soleus and both gastrocnemius heads equally is wrong, because section 2.2 shows they do different jobs.

Required initial groups, per side:

`ankle_plantarflexors`, `ankle_dorsiflexors`, `ankle_evertors`, `ankle_invertors`, `knee_extensors`, `knee_flexors`, `hip_extensors`, `hip_flexors`, `hip_abductors`, `hip_adductors`, `hip_rotators_internal`, `hip_rotators_external`, `trunk_extensors`, `trunk_flexors`, `trunk_lateral_flexors`, `shoulder_flexors`, `shoulder_extensors`, `shoulder_abductors`, `shoulder_rotators_internal`, `shoulder_rotators_external`, `elbow_flexors`, `elbow_extensors`, `forearm_pronators`, `forearm_supinators`, `wrist_flexors`, `wrist_extensors`, `scapular_stabilizers`.

Each group entry is a unit identifier and a weight from 0 to 1. Weights MUST cite a source, or state that they are an even split pending data.

### 3.4 Timebase

Two timebases, and the distinction matters.

- `seconds` — absolute. Use for one-shot motions.
- `cyclePercent` — 0 to 100, loops. Use for gait and any repetitive motion.

A `cyclePercent` clip MUST declare its period separately, so one walking clip serves several speeds. Note the caveat in section 6.3: timing does not scale linearly with speed.

### 3.5 Interpolation

Default to monotone cubic interpolation, clamped to the range 0 to 1.

Do not use Catmull-Rom or an unclamped spline. Both overshoot, and an overshoot below zero is a negative excitation, which is physically meaningless. A muscle pulls or it relaxes. It never pushes.

Support `step` interpolation for on and off patterns, because the literature reports gait activity as intervals rather than as curves, and a user transcribing Perry will want intervals.

### 3.6 Excitation, not activation

Write keyframes to `efferent.alphaMotor`, which the muscle module treats as excitation `u`.

The muscle module then applies first-order activation dynamics with separate time constants, roughly 10 milliseconds to activate and 40 milliseconds to relax. Those dynamics produce the electromechanical delay of about 50 milliseconds that the literature reports between electromyography onset and force.

If the tool wrote keyframes straight into activation `a`, the delay would appear twice, once in the authored data and once in the model. Force would lag the intended motion by about 100 milliseconds, and a walking clip would visibly drag.

**Consequence for transcribing published data.** An electromyography envelope approximates neural drive. Feed it in as excitation without shifting it. Do not add a lead time to compensate for the delay, because the model already supplies the delay.

---

## 4. Reference clips

The companion `activation-clips.json` holds three clips. All values are excitation from 0 to 1. All are plausible starting points rather than measured ground truth, and each track carries a source note.

### 4.1 `quiet-standing`

Design follows section 2.2.

| Track | Pattern | Peak | Rationale |
|---|---|---|---|
| `soleus` both | Flat, small noise | 0.08 | Tonic. Carries the continuous plantarflexor moment. |
| `gastrocnemius_medial` both | Slow oscillation, about 0.3 Hz | 0.02 to 0.06 | Fluctuates with center-of-mass sway. Damps it. |
| `tibialis_anterior` both | Intermittent bursts | 0.04 | Fires in bursts, not continuously. Creates brief co-contraction. |
| `hip_abductors` both | Flat, very small | 0.03 | Frontal-plane pelvic stability. |
| `trunk_extensors` both | Flat, very small | 0.04 | Holds the trunk against gravity. |
| Everything else | Zero | — | Quiet standing is a low-amplitude task. |

Note the amplitudes. The highest is 0.08. A study detecting standing activity used a 2.5% maximum voluntary contraction threshold, which sets the scale. If your model needs 0.4 excitation in the soleus to stand up, the model is wrong somewhere, most likely in maximum isometric force or in the passive joint moments. **Treat the standing clip as a validation test of the skeleton and muscle parameters, not only as an animation.** That is its most useful property.

The left and right tracks are supplied with a deliberate small phase offset in the gastrocnemius oscillation, because perfectly symmetric sway looks mechanical.

### 4.2 `walk-normal`

Timebase is `cyclePercent`. Zero is right heel strike. Right toe-off is at about 62%. The left leg repeats the right leg shifted by 50%.

Timing follows the sources in section 2.1. Amplitudes are estimates and are flagged as such.

| Muscle or group | Active interval, % cycle | Peak | Note |
|---|---|---|---|
| Gluteus maximus | 92 to 15 | 0.25 | Hip extension into loading. |
| Gluteus medius | 0 to 32 | 0.30 | Stance-phase pelvic stabilization. Single-limb support. |
| Hamstrings | 80 to 15 | 0.25 | Terminal swing deceleration into loading. Overlaps the quadriceps. |
| Vastus group | 90 to 18 | 0.25 | Eccentric through loading response. |
| Rectus femoris | 0 to 10, and 55 to 68 | 0.20 | Two bursts. Loading, then hip flexion at pre-swing. |
| Iliopsoas and hip flexors | 50 to 72 | 0.30 | Swing initiation. |
| Adductor magnus | 50 to 75 | 0.15 | Late stance into early swing. |
| Soleus | 8 to 55 | 0.40 | The largest single contributor. Peaks near 45%. |
| Gastrocnemius | 12 to 52 | 0.35 | Push-off. Peaks near 45%. |
| Tibialis anterior | 55 to 100, and 0 to 15 | 0.30 | Swing clearance, then eccentric control at heel strike. |
| Peroneus longus | 15 to 55 | 0.20 | Stance-phase lateral ankle stability. |
| Trunk extensors | 0 to 12, and 50 to 62 | 0.15 | Two bursts per cycle, one at each heel strike. |
| Shoulder flexors and extensors | Counter-phase to the same-side leg | 0.08 | Arm swing. Low amplitude. Sparse data. |

The quadriceps and hamstring overlap from 80% to 15% is deliberate. Strazza et al. observed it in about 90% of strides.

### 4.3 `flail-arms`

There is no normative dataset for this, so the clip is built rather than cited. Say so in the file.

Construction:

- Antagonist pairs at the shoulder and elbow, driven in counter-phase by offset sine waves.
- Three frequencies per pair, not one, so the motion does not look like a metronome. Use incommensurable ratios, for example 1.0, 1.37 and 2.13, so the pattern does not visibly repeat.
- Left and right at different phases and slightly different frequencies.
- High peak amplitude, 0.6 to 0.8, with brief co-contraction at direction reversals. Real flailing involves co-contraction, unlike standing.
- Scapular stabilizers held at a moderate constant level, about 0.2. Without this the arm drags the shoulder girdle and the motion looks dislocated.
- Trunk and hip tracks at a low level, because a flailing person braces.

This clip is the best early stress test of the muscle module. It drives many units hard, it reverses direction often, and it will expose path-solver instability and integration problems faster than walking will.

---

## 5. Deriving activations instead of authoring them

Three routes, in increasing order of cost and quality.

### 5.1 Static optimization from a bone animation

**This is the one to build.** It answers the question directly, and our muscle module already supplies the hard parts.

Pipeline:

```
canned bone animation (BVH, FBX, mocap)
  -> retarget onto the HumanSim skeleton
  -> inverse kinematics: marker or bone poses to generalized coordinates q(t)
  -> differentiate: qdot(t), qddot(t)
  -> inverse dynamics: net joint moment tau_j(t) per degree of freedom
  -> static optimization per frame: solve for activations
  -> activation tracks
```

The per-frame problem, following the standard formulation:

Minimize the sum over muscles of activation squared, plus reserve actuator terms, subject to the joint-moment equality constraint for each degree of freedom:

```
sum over m of [ a_m * f_m(Fmax_m, l_m, v_m) * r_mj ] + r_devicej * F_device = tau_j
```

with each activation bounded between about 0.01 and 1.

Why this suits us:

| The problem needs | We already have it |
|---|---|
| Moment arm `r_mj` per muscle and degree of freedom | Muscle spec section 8.3. Already computed as a diagnostic. |
| Muscle force at a given length, velocity and activation | Muscle spec section 6. The fiber model. |
| Net joint moment `tau_j` | Inverse dynamics. Both backends can supply it. |
| Muscle length and velocity along the motion | Muscle spec section 5. The path solver. |

The optimization is small. It is a bounded least-squares problem per frame, with roughly as many unknowns as muscles crossing the moved joints. It solves in milliseconds and it parallelizes across frames.

Prescribing the motion exactly, rather than tracking it, makes the problem much more robust and faster to solve, because the nonlinear multibody dynamics leave the optimization entirely. The cost is that it cannot predict any deviation from the supplied motion.

**Known failure modes, which the tool MUST report rather than hide.** The published guidance is explicit that a motion sometimes cannot be achieved by muscles alone, for three reasons: the muscles are not strong enough for the required net joint moments, the net joint moments change faster than the activation and deactivation time constants allow, or filtering of the input data produced unrealistic joint moments.

Therefore:

- Add **reserve actuators** at every degree of freedom, heavily penalized. They absorb the residual moment.
- **Report reserve usage per degree of freedom.** A large reserve means the result is not muscle-driven and the user should not trust it. This is the single most important diagnostic in the pipeline.
- Filter input kinematics deliberately and record the cutoff. Differentiating twice amplifies noise, and a noisy `qddot` produces a wild joint moment.

### 5.2 Reflex controllers

Rather than replay a pattern, generate one from a closed sensorimotor loop.

Geyer and Herr (2010) showed that a muscle-reflex model encoding principles of legged mechanics produces human walking dynamics and muscle activity, with no reference trajectory. SCONE implements this approach as open-source software for predictive simulation of biological motion, and it lets a user define and optimize neuromuscular controllers for a task such as walking speed or energy efficiency.

This is the right long-term answer for standing balance in particular. Balance is a feedback problem. A keyframed standing clip cannot recover from a push, because it has no idea it was pushed. A reflex controller can.

It is also the natural bridge to the planned `nerves` module. A reflex controller *is* a nerve module with a small rule set. The afferent channels listed in base spec section 14.1 and muscle spec section 14 are exactly the inputs a reflex controller needs.

Recommend: build keyframes first, because they are cheap and they give the editor something to edit. Build reflex control in the `nerves` phase. Do not try to make keyframes do balance recovery.

### 5.3 Trained policies

Reinforcement learning on a musculoskeletal model produces a policy that emits activations. MyoSuite and MyoChallenge supply Apache-licensed models and trained baselines.

Cost warning from the literature: on-policy reinforcement learning demands millions of simulation steps, so training on detailed muscle-actuated models commonly takes days or weeks, and controlling these overactuated, high-dimensional, delayed systems remains an open problem. Policies trained on sparse objectives often produce peculiar gaits and unrealistic postures.

Treat this as out of scope for now, but note one thing: a trained policy can be *recorded* and the recording becomes a keyframe clip. That is a legitimate way to get a library of clips later without shipping the policy.

### 5.4 Synergy extraction as a compression step

Whatever produces the activations, run non-negative matrix factorization on the result to compress it into synergies.

- Input: a matrix of muscles by time.
- Output: a weight matrix and a set of excitation primitives.
- Target four to five synergies for gait, and verify with variance accounted for.
- Reject unreliable synergies. Kim et al. use k-means clustering across repeats plus intraclass correlation coefficients to separate reliable from unreliable ones. Do the same rather than accepting whatever the factorization returns.

Two benefits. The clip gets much smaller. More importantly, the user gets a handle they can actually manipulate: five curves instead of several hundred.

---

## 6. Design cautions

### 6.1 Activation is not the same as a working motion

A clip that reproduces published activation will not necessarily walk. Forward dynamics amplifies small errors, and nothing in an open-loop clip corrects them. Expect the first walking clip to take two steps and fall.

Mitigations, in order of preference:

1. Accept it and label the clip as a pattern, not a gait controller.
2. Add a small balance assist at the root, decaying to zero, and report its magnitude honestly.
3. Optimize the clip against a tracking objective, which is the MocoTrack approach.
4. Move to reflex control, per section 5.2.

Do not quietly add a root force and call the result walking.

### 6.2 Left and right are not a mirror

Mirror the *pattern* but allow independent editing, which section 3.2 already requires. Also note that muscle identifiers do not mirror automatically if the naming is inconsistent, so the compiler MUST verify that every `both` target resolves to exactly two units.

Small asymmetry improves realism. Perfectly symmetric gait reads as animation.

### 6.3 Timing does not scale linearly with speed

A `cyclePercent` clip retimed to a shorter period gives a faster walk, not a correct faster walk. Stance-phase fraction falls as speed rises, and the swing fraction grows. Amplitudes also rise nonlinearly.

Ship one clip per speed band rather than one clip stretched across all speeds. Three bands is enough to start: slow, normal, and fast.

### 6.4 Stride-to-stride variability is real

Di Nardo et al. found large variability between strides of the same walk, in the number of activation intervals and in the on and off instants, and identified several distinct activation modalities per muscle.

A perfectly repeating loop is therefore less realistic than a loop with variation. Add an optional per-track jitter: a small random offset in timing and amplitude, drawn per cycle from the kernel's seeded generator.

This MUST use the injected seeded generator, per base spec section 10.7. A clip with jitter must still replay identically from the same seed, or golden trajectory tests break.

---

## 7. Implementation tickets

### A0 — Clip format and playback
`A0.1` Clip schema: tracks, targets, timebase, interpolation modes. Validate with the same generated-JSON-Schema approach as HSDL.
`A0.2` Group definitions with per-unit weights and citations, per section 3.3.
`A0.3` `ActivationClipModule` in the `control` phase. Writes `efferent.alphaMotor`. Replaces `MuscleTestDriveModule`.
`A0.4` Monotone cubic and step interpolation, clamped to 0 to 1.
`A0.5` Side expansion for `both` targets, with a compiler check that each resolves to two units.
`A0.6` Seeded per-cycle jitter, per section 6.4.

### A1 — Reference clips
`A1.1` Load `activation-clips.json` and bind placeholder names to real unit identifiers.
`A1.2` `quiet-standing`. **Use it as a parameter validation test, per section 4.1.**
`A1.3` `flail-arms`. Use it as the muscle module stress test.
`A1.4` `walk-normal`, with the caveat in section 6.1 applied honestly.
`A1.5` Slow and fast walking variants, per section 6.3.

### A2 — Derivation pipeline
`A2.1` Bone animation import and retarget onto the HumanSim skeleton.
`A2.2` Inverse kinematics to generalized coordinates, with a documented filter cutoff.
`A2.3` Inverse dynamics to net joint moments, from both backends.
`A2.4` Per-frame static optimization with bounded least squares.
`A2.5` Reserve actuators with penalty, and **per-degree-of-freedom reserve reporting**. Gate: the pipeline is not usable until this reporting exists.
`A2.6` Export the result as a clip.
`A2.7` Validate against a public dataset where electromyography was recorded alongside kinematics, and compare the derived activation against the measured envelope.

### A3 — Synergies
`A3.1` Non-negative matrix factorization over a muscle-by-time matrix.
`A3.2` Reliability screening with k-means clustering and intraclass correlation, per section 5.4.
`A3.3` Synergy clip type: primitives plus weight matrix.
`A3.4` Round trip: expand a synergy clip to per-muscle tracks, refactorize, and confirm the result matches.

### A4 — Editor
`A4.1` Timeline with one row per track, grouped by region.
`A4.2` Left and right rows paired visually but editable apart.
`A4.3` Synergy view: five curves, with the expanded per-muscle result shown read-only beneath.
`A4.4` Overlay the published normative band behind a track, so a user sees where their curve leaves the literature.
`A4.5` Live activation heat map on the rendered muscles.

### Critical path

`A0.1` → `A0.3` → `A1.2` → `A1.3` → `A1.4` → `A2.4` → `A2.5`

`A1.2` first, because quiet standing is the cheapest clip and it validates the model parameters before anything harder depends on them.

---

## 8. Open questions

1. **What are your actual unit and group names?** Blocks `A1.1`. See section 1.
2. **Does your `efferent.alphaMotor` channel exist yet, and is it an accumulator?** The clip module depends on the accumulator semantics from base spec ADR-004.
3. **Are amplitudes in your sliders excitation or activation?** Section 3.6 matters. If the existing sliders write activation, the clip system should either change them or document the difference.
4. **Do you want jitter on by default?** It looks better and it makes bug reports harder to reproduce. Recommend off by default, on by a per-clip flag.
5. **Which public motion dataset should `A2.7` validate against?** It needs synchronized kinematics and electromyography, which narrows the field considerably.

---

## 9. References

**Gait timing and amplitude**
- Perry, J., & Burnfield, J. M. (2010). *Gait Analysis: Normal and Pathological Function* (2nd ed.). Slack Incorporated.
- Winter, D. A. (2009). *Biomechanics and Motor Control of Human Movement* (4th ed.). Wiley.
- Agostini, V., Nascimbeni, A., Gaffuri, A., Imazio, P., Benedetti, M. G., & Knaflitz, M. (2010). Normative EMG activation patterns of school-age children during gait. *Gait & Posture*, 32(3), 285–289.
- Di Nardo, F., Ghetti, G., & Fioretti, S. (2013). Assessment of the activation modalities of gastrocnemius lateralis and tibialis anterior during gait: a statistical analysis. *Journal of Electromyography and Kinesiology*, 23(6), 1428–1433.
- Strazza, A., et al. (2017). Surface-EMG analysis for the quantification of thigh muscle dynamic co-contractions during normal gait. *Gait & Posture*, 51, 228–233.

**Standing balance**
- Warnica, M. J., Weaver, T. B., Prentice, S. D., & Laing, A. C. (2014). The influence of ankle muscle activation on postural sway during quiet stance. *Gait & Posture*, 39(4), 1115–1121.
- Sasagawa, S., Ushiyama, J., Masani, K., Kouzaki, M., & Kanehisa, H. (2009). Balance control under different passive contributions of the ankle extensors. *Experimental Brain Research*, 196(4), 537–544.
- Arvin, M., et al. (2021). Co-contraction of ankle muscle activity during quiet standing in individuals with incomplete spinal cord injury is associated with postural instability. *Scientific Reports*, 11, 19890.

**Muscle synergies**
- Ivanenko, Y. P., Poppele, R. E., & Lacquaniti, F. (2004). Five basic muscle activation patterns account for muscle activity during human locomotion. *Journal of Physiology*, 556(1), 267–282.
- Kim, Y., Bulea, T. C., & Damiano, D. L. (2016). Novel methods to enhance precision and reliability in muscle synergy identification during walking. *Frontiers in Human Neuroscience*, 10, 455.
- Rabbi, M. F., et al. (2020). Non-negative matrix factorisation is the most appropriate method for extraction of muscle synergies in walking and running. *Scientific Reports*, 10, 8266.
- Torres-Oviedo, G., & Ting, L. H. (2007). Muscle synergies characterizing human postural responses. *Journal of Neurophysiology*, 98(4), 2144–2156.

**Derivation and control**
- Dembia, C. L., Bianco, N. A., Falisse, A., Hicks, J. L., & Delp, S. L. (2020). OpenSim Moco: musculoskeletal optimal control. *PLoS Computational Biology*, 16(12), e1008493.
- Thelen, D. G., & Anderson, F. C. (2006). Using computed muscle control to generate forward dynamic simulations of human walking from experimental data. *Journal of Biomechanics*, 39(6), 1107–1115.
- De Groote, F., Kinney, A. L., Rao, A. V., & Fregly, B. J. (2016). Evaluation of direct collocation optimal control problem formulations for solving the muscle redundancy problem. *Annals of Biomedical Engineering*, 44(10), 2922–2936.
- Geyer, H., & Herr, H. (2010). A muscle-reflex model that encodes principles of legged mechanics produces human walking dynamics and muscle activities. *IEEE Transactions on Neural Systems and Rehabilitation Engineering*, 18(3), 263–273.
- Geijtenbeek, T. (2019). SCONE: open source software for predictive simulation of biological motion. *Journal of Open Source Software*, 4(38), 1421.

**Datasets**
- Fukuchi, C. A., Fukuchi, R. K., & Duarte, M. (2018). A public dataset of overground and treadmill walking kinematics and kinetics in healthy individuals. *PeerJ*, 6, e4640.
- Atzori, M., et al. (2014). Electromyography data for non-invasive naturally-controlled robotic hand prostheses. *Scientific Data*, 1, 140053. (Ninapro)

---

*End of activation authoring document v0.1.*
