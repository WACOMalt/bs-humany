# HumanSim — Muscle Module Technical Specification

**Module `muscle` — Phase 2 of the HumanSim framework**

| | |
|---|---|
| Document | `humansim-muscle-spec` |
| Version | 0.1 (draft for implementation handoff) |
| Status | Planning complete. No code written. |
| Depends on | `humansim-spec` v0.4, sections 10 (kernel), 12 (fidelity), 14.2 (muscle contract) |
| Audience | Implementation agents working a Trello-style board |
| Prose style | ASD-STE100 Issue 9, flavored mode |

---

## 0. How to use this document

This document extends the base specification. It does not replace it. Read `humansim-spec` sections 10, 12 and 14.2 first.

- **Sections 1 to 3** give scope, research results, and decisions. Do not reopen a decision in section 3 without a note to the human.
- **Sections 4 to 13** are the normative spec.
- **Section 14** lists what the nerve module needs from this module.
- **Section 16** holds the tickets.
- **Section 17** holds open questions. Some tickets wait on these.

Conventions follow the base spec. MUST, SHOULD and MAY follow RFC 2119. SI units only.

---

## 1. Scope

### 1.1 What this module does

The `muscle` module adds musculotendon actuators to the HumanSim skeleton. Each actuator attaches to bones at an origin and an insertion. It follows a path that can wrap over bone and tissue surfaces. It contracts under a neural command, and it pulls on the bones it attaches to.

The module answers three requirements from the project owner:

1. **Attachment points.** Each muscle binds to named anatomical sites on named bones.
2. **Flow along a surface.** Each muscle path wraps over obstacle surfaces instead of passing through bone.
3. **Accurate contraction.** Muscle force follows a validated force-length-velocity model, and the resulting joint torque follows from a correctly computed moment arm.

### 1.2 What this module does not do

It does not decide *when* a muscle contracts. It receives an activation command and converts it into force. The `nerves` and `brain` modules supply the command. Until those exist, a test harness supplies it.

It does not model organs, fat, skin or fascia as tissue systems. Tier V (section 9) deforms a muscle surface for display only.

It does not solve muscle redundancy. Mapping a desired joint torque back to a set of muscle activations is an inverse problem, and it belongs to a later control module.

### 1.3 Priorities, in order

1. **Correct moment arms.** A muscle with the right force and the wrong moment arm produces the wrong motion. Path geometry matters more than fiber model refinement.
2. **Numerical stability at low activation.** A relaxed body is the common case. A muscle model that goes singular near zero activation is unusable here.
3. **Accuracy that costs little.** Use validated published models and parameters.
4. **Graceful tier scaling.** The user MUST be able to trade muscle fidelity for speed at run time, as in base spec section 12.

---

## 2. Research findings

### 2.1 Musculotendon dynamics

Millard et al. (2013) compared three Hill-type formulations and measured both speed and accuracy against biological muscle. The results set the design.

| Model | Tendon | State variables per unit | Relative speed | Mean absolute error |
|---|---|---|---|---|
| Equilibrium | Elastic | 2 (activation, fiber length) | Baseline | Under 8.9% of max isometric force |
| Damped equilibrium | Elastic | 2 | 29x faster at low activation with an explicit integrator. 3x faster with an implicit integrator. Speeds converge at high activation. | Under 8.9% |
| Rigid tendon | Rigid | 1 (activation) | 2x to 54x faster than elastic with an explicit integrator. 6x to 31x faster with an implicit integrator. Applies to short tendons only. | Under 20.9% |

Three conclusions follow.

First, the damped equilibrium model dominates the plain equilibrium model. It gives the same accuracy and runs faster. It also removes the singularity that the equilibrium model has at zero activation, so it needs no clamping hacks.

Second, the rigid-tendon model is much faster but much less accurate. Its error more than doubles. It also cannot store and release elastic energy, which matters for gait and for any ballistic movement.

Third, the accuracy gap between models is smaller than the accuracy gap that a wrong moment arm creates. This supports priority 1 in section 1.3.

### 2.2 Muscle path and wrapping

A muscle path is a curve from origin to insertion. The curve must not pass through bone. The standard model treats the path as a frictionless elastic band that slides over rigid obstacle surfaces.

| Method | Surfaces | Notes |
|---|---|---|
| Via points | None | Fixed points the path must pass through. Cheap. Produces discontinuities in the moment arm, because a via point does not move with the joint. |
| Obstacle-set (Garner and Pandy, 2000) | Two maximum. Sphere, cylinder, or one of each. | Computes the exact geodesic in closed form. Needs a series of case distinctions. Does not generalize past two surfaces. The case switches create discontinuities. |
| Multi-surface concatenation (Stavness et al., 2012) | Many | Treats the path as straight segments joined by surface geodesics. Iterates the geodesic start points until adjacent segments meet collinearly. |
| Natural Geodesic Variations (Scholz et al., 2015) | Many, general smooth surfaces | Parameterizes each geodesic by start point, direction and length. Finds the shortest path with Newton's method on a global path-error equation, using an explicit banded Jacobian. Fast and general. |

A 2024 study (Zhang et al., bioRxiv) reworked the obstacle-set method into a smooth differentiable form and removed the conditional switches. The paper confirms that the original method's case distinctions break moment-arm continuity, and that a smooth form is needed for gradient-based work.

**Finding: Natural Geodesic Variations is the right target.** It handles many surfaces, handles general smooth surfaces rather than only spheres and cylinders, and it is fast.

### 2.3 What MuJoCo gives and what it withholds

MuJoCo models tendons as minimum-path-length strings with wrapping and via-point constraints. The documentation states that the mechanism resembles OpenSim but implements a more restricted, closed-form set of wrapping options, to increase speed. Ikkala and Hämäläinen (2020) measured MuJoCo at roughly 600 times faster than OpenSim over 97 forward simulations, and attribute the gap largely to closed-form against iterative tendon routing.

The restrictions are specific and they matter:

- Only spheres and cylinders wrap. Ellipsoids do not.
- A cylinder wraps as if it has infinite length.
- Two wrapping geoms in one path MUST have a site between them. This avoids an iterative solver.
- The user can set a preferred side, to stop the tendon jumping across a geom.
- MuJoCo muscles are not volumetric. Each is a single line of action.
- The MuJoCo muscle actuator supports **rigid tendons only**, and it does **not** model variable pennation angles.
- MuJoCo treats actuator length as the sum of tendon length and muscle length.

The last two points are the important ones. The base spec (`humansim-spec` section 15.4) recommended that we use MuJoCo's muscle actuators first and write our own version later. **This research reverses that recommendation.** MuJoCo's muscle model is a simplified Hill-type model with a rigid tendon. Adopting it would lock the project to the 20.9% error tier from section 2.1, and it would drop elastic energy storage.

MuJoCo's *path* machinery remains excellent and we should use it where it fits.

### 2.4 Volumetric muscle

Line-of-action models compute force well. They show nothing. A line does not bulge.

| Approach | Cost | Use |
|---|---|---|
| Finite element, full continuum | Very high | Research on tissue stress. Not real time at body scale. |
| Decoupled solid and fiber FEM | Moderate | Real-time single muscle. Kapravchuk et al. (2025) report real-time deformation with this split. |
| Extended Position Based Dynamics (Romeo et al., 2020) | Low | Adds an anisotropic term to the distance constraints between mesh points to embed fibers. Applies overpressure to preserve volume under contraction. Runs in real time. |
| VIPER position-based rods (Angles et al., 2019) | Low | Rods carry a scale degree of freedom. Models large deformation, muscle extrusion and skinning. |

XPBD suits this project. It is stable at large time steps, it needs no global matrix assembly, and its per-constraint updates map well to parallel hardware.

**Finding: treat volumetric muscle as a display layer.** It reads muscle state and deforms a surface. It does not feed force back into the solver. This mirrors the kinematic redistribution rule in base spec section 4.3, and it keeps visual quality independent of solver cost.

### 2.5 Reference implementations and parameter sources

| Source | Content | License | Use |
|---|---|---|---|
| Rajagopal et al. (2016) | 80 lower-limb muscle-tendon units with validated Hill parameters. Also 17 upper-body torque actuators. | Freely distributed on SimTK | Primary parameter source for the lower limb. |
| MyoSuite `myoLeg`, `myoArm`, `myoHand`, `myoTorso` | MuJoCo conversions of OpenSim models. `myoHand` has 29 bones, 23 joints and 39 muscle-tendon units. | Apache 2.0 | Primary reference for how OpenSim muscle geometry maps to MJCF. Safe to use directly. |
| Holzbaur et al. (2005) upper extremity model | Upper-limb muscle paths and parameters | Open | Primary parameter source for the arm. |
| Hyfydy | Implements Millard (2013) with elastic tendons, pennation and fiber damping. Roughly 100x faster than OpenSim. | Commercial license | Do not depend on it. It is proof that research-grade muscle models can run at interactive speed. Its published engineering choices are useful prior art. |
| MyoSkeleton | Full-body model with a large muscle set | Non-commercial research license | Validation oracle only, per base spec ADR-009. Never vendor it. |
| MyoConverter | Converts OpenSim models to MuJoCo | Apache 2.0 | Useful tool. Known problems with discontinuous wrapping paths and with geometry parsing. Expect manual repair. |

---

## 3. Architecture decision records

Numbered from M-ADR-001 to keep them distinct from the base spec.

---

### M-ADR-001 — Write our own musculotendon dynamics. Do not adopt MuJoCo's.

**Decision.** The module implements the Millard (2013) damped equilibrium model with an elastic tendon and a variable pennation angle. It does not call MuJoCo's `muscle` actuator.

**Rationale.** MuJoCo's muscle actuator supports rigid tendons only and does not model variable pennation. Section 2.1 shows that a rigid tendon more than doubles the force error, from under 8.9% to under 20.9% of maximum isometric force. Elastic tendons also store and release energy, and that mechanism drives gait efficiency. The project owner accepts a slow simulation in exchange for accuracy, so paying for an elastic tendon is the correct trade.

This reverses the recommendation in base spec section 15.4, which was written before this research. Update that section to point here.

**Consequence.** The muscle model is portable. It runs above `IPhysicsBackend` and works on both backends. This is a benefit we did not expect to get.

**Cost.** We must implement and validate the fiber dynamics ourselves. Budget this as the largest single item in the module.

---

### M-ADR-002 — Use the backend's path solver where it is adequate. Write our own where it is not.

**Decision.** Muscle path length and moment arms come from a `IMusclePathSolver` interface with two implementations. `NativeTendonPathSolver` delegates to MuJoCo spatial tendons. `GeodesicPathSolver` implements Natural Geodesic Variations.

**Rationale.** MuJoCo's closed-form router is fast, and the speed gap against iterative routing is large. For a muscle that wraps one sphere or one cylinder, the native router is the correct choice. But MuJoCo cannot wrap an ellipsoid, it treats every cylinder as infinite, and it requires a site between two wrap geoms. Several important muscles break these limits. The deltoid wraps the humeral head, which is an ellipsoid. Garner and Pandy noted that the deltoid is the case that motivated obstacle-set methods, because it crosses a joint with several degrees of freedom.

A single solver cannot serve both needs. Two solvers behind one interface can.

**Consequence.** The HSDL muscle definition MUST declare which solver each muscle needs, and the compiler MUST reject a muscle whose declared surfaces the chosen solver cannot handle.

---

### M-ADR-003 — Muscle force enters the simulation through `actuation.bodyWrench`, not through joint torque.

**Decision.** A muscle applies a force at its origin site, an equal and opposite force at its insertion site, and a reaction force at every point where the path touches a wrapping surface. All of these go into the `actuation.bodyWrench` accumulator channel.

**Rationale.** This is physically correct, and it removes a whole class of error. If a module converts muscle force into joint torque directly, it must compute a moment arm and it can get it wrong silently. Applying real forces at real points makes the joint torque emerge from the solver, and it makes the moment arm a *derived diagnostic* rather than an input.

The wrap reaction force matters and implementations often omit it. A muscle that wraps the patella pushes on the patella. Leaving that force out changes the joint loading.

**Consequence.** The moment arm still gets computed, but only for reporting and validation (section 8.3). A discrepancy between the reported moment arm and published data becomes a test failure rather than a silent error.

**Exception.** Tier 1 (section 12) applies lumped joint torque directly, because it has no path geometry. Tier 1 MUST report itself as an approximation.

---

### M-ADR-004 — Volumetric muscle is a display layer with no feedback into dynamics.

**Decision.** Tier V reads `muscle.state` and deforms a surface mesh with XPBD. It writes to a render channel. It never writes to `actuation.*`.

**Rationale.** One-way flow keeps the simulation deterministic and keeps its cost bounded. It mirrors kinematic redistribution in the base spec, which solved the same problem for bones. It also means the user can turn Tier V off without changing the physics, so the fidelity slider does not change results.

Coupling deformation back into dynamics is a research project. It is not ruled out forever, but it is out of scope, and the channel design keeps the door open.

---

### M-ADR-005 — A broad muscle is several lines of action, not one.

**Decision.** HSDL models a broad muscle as a named group of parallel muscle-tendon units. Each unit has its own path and its own parameters.

**Rationale.** A single line cannot represent a muscle whose regions have opposite actions. The anterior deltoid flexes the shoulder and the posterior deltoid extends it. One line through the middle produces neither. The same applies to gluteus medius, pectoralis major, trapezius and latissimus dorsi.

**Consequence.** Muscle counts in this document refer to muscle-tendon units, not to anatomical muscles. The count is larger than the anatomy textbook count.

---

## 4. Domain model

### 4.1 Entities

```
MuscleSystem
├── MuscleGroup × G          anatomical muscle: name, TA term, innervation slot
│   └── MuscleTendonUnit × N one line of action
│       ├── AttachmentSite   origin: bone id + local point
│       ├── AttachmentSite   insertion: bone id + local point
│       ├── PathElement × P  ordered: via point or wrap surface
│       └── MtuParameters    Hill-type parameters
├── WrapSurface × W          sphere, cylinder, ellipsoid, torus. Bound to a bone.
└── FiberState × N           activation, normalized fiber length. Solver state.
```

### 4.2 Attachment sites

The base spec already requires an `attachmentSites` section in HSDL (base spec section 14.5, item 2). This module consumes it.

An attachment site is a point in **bone-local** coordinates on a named bone. The bone may or may not be its own rigid body at the active fidelity profile. When the bone is a follower rather than a solver body, the site resolves to the owning segment through the follower transform. This is the reason the base spec made bone ids a stable public interface.

An attachment site MUST carry a provenance citation, and it MUST NOT come from clicking on licensed mesh geometry. Base spec ADR-009 applies without change.

### 4.3 Wrap surfaces

A wrap surface is a rigid primitive attached to a bone. It represents bone, cartilage or another muscle that the path slides over.

Supported types, in order of implementation:

1. `sphere` — radius. Both solvers.
2. `cylinder` — radius, and a finite half-length. `GeodesicPathSolver` respects the length. `NativeTendonPathSolver` cannot, so the compiler MUST warn when a finite cylinder maps to the native solver.
3. `ellipsoid` — three semi-axes. `GeodesicPathSolver` only.
4. `torus` — MAY be added later for muscles that route around a groove.

Each surface declares a preferred side, so the path does not jump from one side to the other between ticks. A jump changes the moment arm sign and destabilizes the simulation.

### 4.4 Path elements

An ordered list between origin and insertion. Each element is one of:

- `viaPoint` — a bone-local point the path passes through. Cheap and stable, but it does not move with joint angle, so it distorts the moment arm away from the pose where it was placed. Use it only where published models use it.
- `conditionalViaPoint` — a via point active only within a joint-angle range. Common in OpenSim models. It introduces a discontinuity, so the module MUST blend activation across a small band rather than switching at a threshold.
- `wrap` — a reference to a wrap surface.

---

## 5. Path solver

### 5.1 Interface

```ts
interface IMusclePathSolver {
  readonly id: string;              // "native" | "geodesic"
  readonly capabilities: PathSolverCapabilities;

  compile(mtus: CompiledMtu[]): PathCompileReport;

  /** Writes path length and path velocity for every unit. No allocation. */
  solve(
    pose: PoseBuffer,
    velocity: VelocityBuffer,
    outLength: Float64Array,        // [N]
    outVelocity: Float64Array,      // [N]
    outContacts: PathContactBuffer  // wrap reaction points and directions
  ): void;
}

interface PathSolverCapabilities {
  surfaceTypes: WrapSurfaceType[];
  maxSurfacesPerPath: number;
  finiteCylinders: boolean;
  requiresSiteBetweenWraps: boolean;
  continuousMomentArm: boolean;
}
```

### 5.2 `GeodesicPathSolver` requirements

Implement Natural Geodesic Variations (Scholz et al., 2015).

- Treat the path as straight segments joined by geodesic segments on each surface.
- Parameterize each geodesic by its start point, its start direction and its length.
- Build a global path-error function. The error is zero when every geodesic meets its neighboring straight segments collinearly.
- Solve with Newton's method. Use the explicit banded Jacobian the paper gives. Do not use a numerical Jacobian, because the cost grows with path length and the accuracy falls.
- Warm-start every solve from the previous tick's solution. Muscle paths change slowly between ticks at 500 Hz, so most solves SHOULD converge in one or two iterations.
- Cap the iteration count. On failure, hold the previous path, flag the unit in diagnostics, and continue. A muscle that fails to converge MUST NOT stop the simulation.

### 5.3 Path velocity

The fiber model needs the rate of change of path length. Compute it analytically from the path geometry and the body velocities. Do not compute it by differencing length between ticks, because that adds a one-tick lag and it amplifies noise.

### 5.4 Contact reporting

`solve` MUST report, for each wrap contact, the world point, the surface normal, and the body the surface belongs to. Section 8.2 needs these to apply the reaction force.

---

## 6. Musculotendon dynamics

### 6.1 Model

Implement the Millard (2013) damped equilibrium musculotendon model.

The unit has an active contractile element, a parallel passive elastic element, and an elastic tendon in series. A pennation angle relates fiber length to the length along the line of action.

Four curves define the behavior:

- Active force-length. Force falls off as the fiber moves away from its optimal length.
- Force-velocity. Force falls as the fiber shortens faster, and rises under lengthening.
- Passive force-length. Force rises steeply past optimal fiber length.
- Tendon force-length. Force rises nonlinearly past tendon slack length.

Each curve MUST be implemented as a smooth, monotone, invertible function with continuous first and second derivatives. Piecewise linear curves break implicit integrators.

### 6.2 The damping term

The damped equilibrium model adds a damping element in parallel with the contractile element. Millard reports a damping coefficient of 0.1 as the default working value.

This term is not cosmetic. Without it, the fiber velocity is undefined at zero activation, and the model needs clamping to avoid a division by zero. With it, the model is well-behaved at zero activation, which is the common case for a relaxed body. This is why the damped model runs 29 times faster than the undamped model at low activation.

### 6.3 State

Per muscle-tendon unit, with an elastic tendon:

| State | Symbol | Range |
|---|---|---|
| Activation | `a` | 0 to 1 |
| Normalized fiber length | `lMtilde` | positive |

Both integrate on the kernel's fixed step. Both live in the `muscle.state` channel.

With a rigid tendon (Tier 2-fast, section 12) the fiber length becomes algebraic and only activation integrates.

### 6.4 Activation dynamics

Convert neural excitation `u` into activation `a` with a first-order model. Activation and deactivation use different time constants, because a muscle activates faster than it relaxes. Typical published values are 10 ms for activation and 40 ms for deactivation. Both MUST be per-muscle parameters with citations, not global constants.

### 6.5 Parameters

Per muscle-tendon unit:

| Parameter | Unit | Note |
|---|---|---|
| Maximum isometric force | N | Scales with physiological cross-sectional area. |
| Optimal fiber length | m | |
| Tendon slack length | m | Sensitive. Small errors here shift the whole operating range. |
| Pennation angle at optimal fiber length | rad | |
| Maximum contraction velocity | optimal fiber lengths per second | Typically 10. |
| Activation time constant | s | |
| Deactivation time constant | s | |
| Damping coefficient | dimensionless | Default 0.1. |

Every parameter MUST carry a source citation, as base spec section 5.3 requires for joint ranges.

### 6.6 Parameter scaling with morphology

The base spec makes the skeleton parametric. Muscles MUST follow.

- Optimal fiber length and tendon slack length scale with the distance between origin and insertion in the neutral pose. Scale both, and preserve their ratio. Scaling only one shifts the operating range and it is a known failure mode in the OpenSim scaling workflow.
- Maximum isometric force scales with physiological cross-sectional area, which scales roughly with the square of a linear dimension. Do not scale it with mass directly.
- Apply the sex parameter from base spec section 6. Document the source for any sex difference in muscle strength, or state plainly that the module applies none.

---

## 7. Fiber state integration

The kernel is a fixed-step system, so the muscle module cannot use the variable-step error-controlled integrators that OpenSim and Hyfydy use.

Requirements:

- Integrate fiber length and activation with a semi-implicit method. The fiber dynamics are stiff near the ends of the force-length curve.
- Run the muscle module at the physics rate or at a divisor of it, set per fidelity tier. Do not run it slower than 500 Hz at Tier 2 or above.
- Detect and report stiffness problems. A fiber length that leaves its valid range, or an activation outside 0 to 1, indicates a step size that is too large. Report it in diagnostics rather than clamping silently.
- Keep the state in the snapshot (base spec section 13.7), so a session restores exactly.

---

## 8. Force application

### 8.1 Path force

The tendon force is a scalar. It acts along the path. At every straight segment, the force pulls both ends toward each other along the segment direction.

### 8.2 Applying force to bodies

For each muscle-tendon unit, each tick:

1. Get the tendon force from the fiber model.
2. Apply the force at the origin site, directed along the first path segment.
3. Apply the equal and opposite force at the insertion site, directed along the last path segment.
4. For each wrap contact, apply the reaction force to the wrapping body. The direction is the resultant of the two adjacent segment directions.
5. Accumulate all of these into `actuation.bodyWrench`.

Step 4 is the one that implementations skip. Do not skip it. A muscle that wraps a bone pushes on that bone, and the joint reaction force is wrong without it.

### 8.3 Moment arm as a derived quantity

Compute the moment arm for each unit and each crossed degree of freedom as the partial derivative of path length with respect to the generalized coordinate. This follows from the principle of virtual work.

Compute it analytically where the solver supports it. Otherwise use a central difference with a documented step size.

The moment arm is **output only**. It never enters the force path (M-ADR-003). It exists to be validated against published data (section 13.2).

---

## 9. Tier V — volumetric display layer

### 9.1 Purpose

Show muscle shape change. A contracting biceps should bulge. A line of action cannot show that.

### 9.2 Method

Implement muscle surface deformation with XPBD, following Romeo et al. (2020).

- Represent each muscle as a tetrahedral or surface mesh with particles.
- Add an anisotropic term to the distance constraints between mesh points. The anisotropy axis is the fiber direction, so contraction shortens the mesh along the fiber and not across it.
- Apply overpressure to preserve volume. A muscle that shortens must thicken.
- Constrain the mesh ends to the origin and insertion attachment sites.
- Add collision constraints against bone collision proxies, so a muscle does not sink into a bone.

### 9.3 Coupling rules

- Tier V reads `muscle.state` and `body.boneTransforms`. It writes `render.muscleMesh` only.
- Tier V MUST NOT write to any `actuation.*` channel (M-ADR-004).
- Tier V runs in the `post` phase, at a divisor of the physics rate. 60 Hz is enough.
- Tier V may fail to converge without affecting the simulation. Report and continue.

### 9.4 Geometry source

Muscle meshes are an asset-pack concern, as bone meshes are. Base spec ADR-005 and ADR-009 apply without change. Tier V MUST work with procedurally generated muscle volumes, generated by sweeping a cross-section along the muscle path. Licensed anatomical meshes are an optional upgrade, never the source of truth.

---

## 10. Kernel integration

### 10.1 Modules

| Module id | Phase | Rate | Writes |
|---|---|---|---|
| `muscle.path` | `actuate` | physics rate | `muscle.path` |
| `muscle.dynamics` | `actuate` | physics rate | `muscle.state`, accumulates `actuation.bodyWrench` |
| `muscle.moment` | `post` | 60 Hz | `diagnostics.momentArm` |
| `muscle.volume` | `post` | 60 Hz | `render.muscleMesh` |

`muscle.path` MUST run before `muscle.dynamics`. Declare the order with the `order` field in the manifest.

### 10.2 Channels

| Channel | Mode | Writer | Contents |
|---|---|---|---|
| `muscle.path` | single-writer | `muscle.path` | length[N], velocity[N], contact list |
| `muscle.state` | single-writer | `muscle.dynamics` | activation[N], fiber length[N], fiber velocity[N], tendon force[N], fiber force[N] |
| `efferent.alphaMotor` | accumulator | *(nerves, later)* | excitation 0 to 1, [N] |
| `efferent.gammaMotor` | accumulator | *(nerves, later)* | spindle gain, [N]. Declared now, unused. |
| `diagnostics.momentArm` | single-writer | `muscle.moment` | moment arm per unit and per crossed degree of freedom |
| `render.muscleMesh` | single-writer | `muscle.volume` | deformed vertex positions |

Until the nerve module exists, a `MuscleTestDriveModule` writes to `efferent.alphaMotor`. It supports a constant level, a sine sweep, a step, and a scripted pattern from a scenario file.

### 10.3 Base spec obligations that this module consumes

This module is the first real test of the forward-compatibility work in base spec section 14.5. Confirm each on arrival:

| Obligation | Used how |
|---|---|
| Item 2: `attachmentSites` populated | Origins and insertions bind to them. |
| Item 3: HSDL extension namespaces | Muscle definitions live in a `muscle.*` namespace. |
| Item 4: realized per-degree-of-freedom force readable | Validates that applied muscle forces produce the expected joint torque. |
| Item 8: accumulator channels with several writers | Several muscles write to `actuation.bodyWrench` in one tick. |
| Item 10: bone ids are a stable interface | Every attachment binds to a bone id. |

If any obligation is missing or broken, that is a base-spec bug. Fix it there, not here.

---

## 11. Backend split

| Concern | Rapier backend | MuJoCo backend |
|---|---|---|
| Fiber dynamics | Ours. Identical code. | Ours. Identical code. |
| Path solving | `GeodesicPathSolver` only. Rapier has no tendon primitive. | `NativeTendonPathSolver` where the muscle fits its limits. `GeodesicPathSolver` otherwise. |
| Force application | `applyBodyWrench` | `applyBodyWrench` |
| Expected relative speed | Slower path solving. Faster rigid-body step. | Faster path solving for simple wraps. |

The fiber model is portable because of M-ADR-001. This is the payoff for not adopting MuJoCo's actuator, and it is worth stating plainly: rejecting the native muscle model made the module backend-independent.

---

## 12. Fidelity tiers

These extend the base spec section 12 profiles. Muscle tier and skeleton profile are independent controls.

| Tier | Units | Path model | Fiber model | Target |
|---|---|---|---|---|
| `M0-none` | 0 | — | — | Skeleton only. Base spec behavior. |
| `M1-lumped` | ~40 groups | None. Fixed moment arm per joint. | Activation only. | Interactive. Reports itself as an approximation. |
| `M2-line` | ~80 to ~300 | Via points and wrapping | Damped equilibrium, elastic tendon | The main deliverable. |
| `M2-fast` | ~80 to ~300 | Via points and wrapping | Rigid tendon | Roughly 2x to 54x faster fiber step. Error rises to about 20.9%. Must be labeled. |
| `M3-full` | ~600+ | Wrapping, several units per broad muscle | Damped equilibrium, elastic tendon | Not real time. |
| `V-volume` | Any | — | — | Adds Tier V display. Combines with M1 to M3. |

The user interface MUST show the measured cost of each tier, as the base spec requires. It MUST also show the documented error band, so a user choosing `M2-fast` sees what accuracy they gave up.

---

## 13. Validation and testing

### 13.1 Unit tests

- Each of the four characteristic curves, against published sample values.
- Curve derivatives, checked against a numerical derivative.
- Fiber equilibrium at known activation and known length.
- Activation dynamics step response against the analytic solution.
- Path length on a straight path with no wrapping, against the direct distance.
- Path length on a single cylinder wrap, against the closed-form arc result.
- Moment arm from virtual work, against the analytic value for a simple hinge and a cylinder.

### 13.2 Moment arm validation

This is the most important test in the module, and it MUST run in continuous integration.

For each muscle that crosses a joint, sweep the joint through its range and record the moment arm. Compare against published cadaver measurements and against the Rajagopal or MyoSuite model. Report the maximum and mean deviation.

A moment arm that changes sign where published data does not is a hard failure. A discrepancy over a documented tolerance is a failure that needs a written explanation.

### 13.3 Single-muscle benchmarks

Reproduce the benchmark cases from Millard (2013). Drive a single muscle with constant activation and a sinusoidal length change. Compare the force profile against the published curves. This confirms the fiber implementation before any full-body work.

### 13.4 Physical plausibility

Add to the base spec section 13.4 suite:

- A muscle at zero activation produces only passive force, and that force is never negative.
- Tendon force is never negative. A tendon pulls and never pushes.
- Total force applied to bodies by one unit sums to zero, and total torque about the whole system sums to zero, absent external constraint.
- Muscle work over a closed kinematic loop at zero activation is not positive.
- No fiber length leaves its valid range at the configured step size.

### 13.5 Golden trajectories

Extend the base spec harness. Add scenarios: `elbow-flexion-isometric`, `elbow-flexion-isotonic`, `quiet-stance-cocontraction`, `muscle-sweep` (drive every unit through a standard activation profile and record forces).

`muscle-sweep` doubles as a validation report.

---

## 14. Forward compatibility for the nerve module

The nerve module is the next layer. It needs the following from this module. Build all of it now, because retrofitting it is expensive.

| Need | Channel | Status |
|---|---|---|
| Muscle length and velocity, for spindle afferents (Ia and II) | `muscle.state` publishes fiber length and fiber velocity | MUST publish both from the start |
| Muscle force, for Golgi tendon organ afferents (Ib) | `muscle.state` publishes tendon force | MUST publish |
| Motor drive input | `efferent.alphaMotor` accumulator | MUST exist and work with several writers |
| Spindle sensitivity control | `efferent.gammaMotor` accumulator | MUST be declared. May stay unused. |
| Conduction delay | Kernel `DelayLine` primitive, base spec section 10.5 | Already built. This module is its first consumer. |
| Motor unit structure | Not modeled in this module | See open question 4 |

Note on realism: a real muscle receives drive as discrete motor unit recruitment, not as one continuous activation value. This module models one activation per unit. That is standard practice and it is adequate for a reflex loop. It is not adequate for simulating electromyography. Record it as a known limitation.

---

## 15. Repository additions

```
packages/
├── muscle-model/       fiber dynamics, curves, activation. Pure. No backend dependency.
├── muscle-path/        IMusclePathSolver, geodesic solver, native adapter
├── muscle-data/        muscle definitions, parameters, citations
├── modules-muscle/     kernel modules from section 10.1
└── muscle-volume/      Tier V XPBD layer
```

`muscle-model` MUST have no dependency on the kernel, on a backend, or on three.js. It takes numbers and returns numbers. This makes it directly testable against published benchmarks.

---

## 16. Milestones and tickets

### N0 — Model foundations
`N0.1` Curve implementations: active force-length, force-velocity, passive force-length, tendon force-length. Smooth, monotone, invertible.
`N0.2` Curve tests against published sample values and numerical derivatives.
`N0.3` Activation dynamics with separate time constants.
`N0.4` Damped equilibrium fiber model. Semi-implicit integration.
`N0.5` Reproduce the Millard (2013) single-muscle benchmarks. **Gate: do not start N1 until this passes.**
`N0.6` Rigid-tendon variant for Tier `M2-fast`.

### N1 — Path solving
`N1.1` `IMusclePathSolver` interface and capability reporting.
`N1.2` Straight-path and via-point solver. Analytic path velocity.
`N1.3` Conditional via points with blended transitions.
`N1.4` Single-surface geodesics: sphere, then cylinder with finite length, then ellipsoid.
`N1.5` Natural Geodesic Variations multi-surface solver with the explicit banded Jacobian.
`N1.6` Warm-start and iteration cap with failure reporting.
`N1.7` `NativeTendonPathSolver` over MuJoCo spatial tendons, with a compile-time check against MuJoCo's limits.
`N1.8` Moment arm computation by virtual work.
`N1.9` Moment arm validation harness against published data. **Runs in continuous integration.**

### N2 — Data
`N2.1` HSDL `muscle.*` schema: units, groups, paths, wrap surfaces, parameters.
`N2.2` Attachment sites for the muscles in scope, with citations.
`N2.3` Wrap surface definitions with citations.
`N2.4` Lower-limb parameter set from Rajagopal 2016. About 80 units.
`N2.5` Upper-limb parameter set from Holzbaur 2005.
`N2.6` Morphology scaling for muscle parameters, per section 6.6.
`N2.7` Trunk and neck parameter set.

### N3 — Kernel integration
`N3.1` `muscle.path` module.
`N3.2` `muscle.dynamics` module with `actuation.bodyWrench` accumulation, including wrap reaction forces.
`N3.3` `MuscleTestDriveModule` with constant, sine, step and scripted patterns.
`N3.4` `muscle.moment` diagnostics module.
`N3.5` Confirm the five base spec section 14.5 obligations listed in section 10.3.
`N3.6` Tier selection and live switching.
`N3.7` **First muscle-driven motion.** Drive the elbow flexors and watch the forearm lift. *The demo milestone.*
`N3.8` Golden trajectories and plausibility assertions.
`N3.9` Benchmarks: milliseconds per step by tier, unit count and backend.

### N4 — Display
`N4.1` Muscle path rendering with tension coloring.
`N4.2` Procedural muscle volume generation by sweeping a cross-section along the path.
`N4.3` XPBD solver with anisotropic fiber constraints and overpressure.
`N4.4` Bone collision constraints for muscle meshes.
`N4.5` Muscle inspector panel: name, innervation slot, current length, force, activation, moment arms.

### N5 — Scale and hardening
`N5.1` `M3-full` unit set.
`N5.2` Several units per broad muscle, per M-ADR-005.
`N5.3` Performance pass against N3.9 baselines.
`N5.4` External validation against MyoSuite models in continuous integration, and against MyoSkeleton locally.
`N5.5` Validation report publication.

### Critical path

`N0.1` → `N0.4` → `N0.5` → `N1.2` → `N1.8` → `N2.4` → `N3.2` → `N3.7`

`N0.5` and `N3.7` are the two gates. Do not build breadth before `N0.5` passes.

---

## 17. Open questions

1. **Which region first?** The elbow is the best demo. It needs few muscles, it has a clear expected behavior, and Holzbaur gives the parameters. The lower limb has better validation data through Rajagopal. Recommend the elbow for `N3.7`, then the lower limb for depth.
2. **Does Tier V need real anatomical muscle meshes to be worth building?** Procedural sweeps may look poor for broad flat muscles such as the trapezius. Recommend building N4.2 first and judging before committing to N4.3.
3. **How many units at `M3-full`?** A published full-body model runs past 600 units. The cost scales with it. Set the target after the N3.9 benchmarks exist.
4. **Do we model motor units?** Section 14 notes that this module uses one activation per unit. A motor unit pool would improve nerve realism and electromyography work, and it would raise cost. Defer until the nerve module has a stated need.
5. **Co-contraction and redundancy.** Nothing here decides how much each muscle contributes to a movement. That is the control problem. Confirm that it belongs to a later module and not here.

---

## 18. References

**Musculotendon dynamics**
- Millard, M., Uchida, T., Seth, A., & Delp, S. L. (2013). Flexing computational muscle: modeling and simulation of musculotendon dynamics. *Journal of Biomechanical Engineering*, 135(2), 021005.
- Zajac, F. E. (1989). Muscle and tendon: properties, models, scaling, and application to biomechanics and motor control. *Critical Reviews in Biomedical Engineering*, 17(4), 359–411.
- Thelen, D. G. (2003). Adjustment of muscle mechanics model parameters to simulate dynamic contractions in older adults. *Journal of Biomechanical Engineering*, 125(1), 70–77.

**Muscle path and wrapping**
- Garner, B. A., & Pandy, M. G. (2000). The obstacle-set method for representing muscle paths in musculoskeletal models. *Computer Methods in Biomechanics and Biomedical Engineering*, 3(1), 1–30.
- Scholz, A., Sherman, M., Stavness, I., Delp, S., & Kecskeméthy, A. (2015). A fast multi-obstacle muscle wrapping method using natural geodesic variations. *Multibody System Dynamics*, 36(2), 195–219.
- Stavness, I., Sherman, M., & Delp, S. (2012). A general approach to muscle wrapping over multiple surfaces. *American Society of Biomechanics, 36th Annual Meeting*.
- Gao, F., Damsgaard, M., Rasmussen, J., & Christensen, S. T. (2002). Computational method for muscle-path representation in musculoskeletal models. *Biological Cybernetics*, 87(3), 199–210.

**Models and parameters**
- Rajagopal, A., et al. (2016). Full-body musculoskeletal model for muscle-driven simulation of human gait. *IEEE Transactions on Biomedical Engineering*, 63(10), 2068–2079.
- Holzbaur, K. R. S., Murray, W. M., & Delp, S. L. (2005). A model of the upper extremity for simulating musculoskeletal surgery and analyzing neuromuscular control. *Annals of Biomedical Engineering*, 33(6), 829–840.
- Caggiano, V., Wang, H., Durandau, G., Sartori, M., & Kumar, V. (2022). MyoSuite: a contact-rich simulation suite for musculoskeletal motor control. *L4DC*. arXiv:2205.13600.

**Volumetric muscle**
- Romeo, M., Monteagudo, C., & Sánchez-Quirós, D. (2020). Muscle and fascia simulation with extended position based dynamics. *Computer Graphics Forum*, 39(1), 134–146.
- Angles, B., et al. (2019). VIPER: volume invariant position-based elastic rods. *Proceedings of the ACM on Computer Graphics and Interactive Techniques*, 2(2).
- Macklin, M., Müller, M., & Chentanez, N. (2016). XPBD: position-based simulation of compliant constrained dynamics. *Motion in Games*.

**Engines**
- Todorov, E., Erez, T., & Tassa, Y. (2012). MuJoCo: a physics engine for model-based control. *IROS*.
- Geijtenbeek, T. (2019). SCONE: open source software for predictive simulation of biological motion. *Journal of Open Source Software*, 4(38), 1421.
- Ikkala, A., & Hämäläinen, P. (2020). Converting biomechanical models from OpenSim to MuJoCo. *ICNR*.

---

*End of muscle module specification v0.1.*
